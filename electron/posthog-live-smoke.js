const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTelemetry } = require('./telemetry');

if (process.env.OPENSHORTS_POSTHOG_LIVE_TEST !== 'true') {
  console.error('Set OPENSHORTS_POSTHOG_LIVE_TEST=true to send live PostHog smoke-test events.');
  process.exit(1);
}

const target = process.env.OPENSHORTS_POSTHOG_TEST_URL || 'http://127.0.0.1:4174/#app';
const marker = `codex-${Date.now()}`;
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'openopusclip-posthog-live-'));
app.setPath('userData', userData);

const telemetry = createTelemetry({
  userData,
  appVersion: 'live-smoke',
  platform: process.platform,
  arch: process.arch,
  packaged: true,
});

ipcMain.handle('open-opus-telemetry:get-context', () => telemetry.getContext());
ipcMain.handle('open-opus-telemetry:capture-feedback', (_event, feedback) => {
  if (!feedback || typeof feedback !== 'object') return false;
  return telemetry.capture('feedback_submitted', feedback);
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  const posthogResponses = [];
  session.defaultSession.webRequest.onCompleted({ urls: ['https://*.posthog.com/*'] }, (details) => {
    posthogResponses.push({ url: details.url, status: details.statusCode });
  });

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  await win.loadURL(target);
  await delay(5000);

  const result = await win.webContents.executeJavaScript(`(async () => {
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const feedbackButton = document.querySelector('#app-feedback-button');
    if (!feedbackButton) throw new Error('Feedback button not found');
    feedbackButton.click();
    await delay(100);
    const categoryButton = [...document.querySelectorAll('button')]
      .find((button) => button.textContent.includes('Something broke'));
    if (!categoryButton) throw new Error('Feedback category not found');
    categoryButton.click();
    await delay(100);
    const detail = document.querySelector('textarea[placeholder="What happened instead?"]');
    if (!detail) throw new Error('Feedback detail field not found');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(detail, 'Live feedback delivery check ${marker}');
    detail.dispatchEvent(new Event('input', { bubbles: true }));
    await delay(100);
    const send = [...document.querySelectorAll('button')]
      .find((button) => button.textContent.includes('Send feedback'));
    send.click();
    const feedbackDeadline = Date.now() + 5500;
    while (
      !document.body.innerText.includes('Your feedback was sent anonymously')
      && Date.now() < feedbackDeadline
    ) {
      await delay(100);
    }
    const feedbackConfirmed = document.body.innerText.includes('Your feedback was sent anonymously');

    const settings = [...document.querySelectorAll('button')]
      .find((button) => button.getAttribute('aria-label') === 'Settings');
    settings?.click();
    console.error(new Error('Live error capture check ${marker}'));
    return { feedbackConfirmed, marker: '${marker}' };
  })()`);

  await delay(12000);
  const screenshot = path.join(os.tmpdir(), `openopusclip-posthog-${marker}.png`);
  await win.capturePage().then((image) => fs.writeFileSync(screenshot, image.toPNG()));

  const replayDelivered = posthogResponses.some(({ url, status }) =>
    (url.includes('/s/') || url.includes('/ses/')) && status >= 200 && status < 300
  );
  const eventsDelivered = posthogResponses.some(({ url, status }) =>
    (url.includes('/i/v0/e/') || url.includes('/e/')) && status >= 200 && status < 300
  );

  console.log(JSON.stringify({
    ...result,
    eventsDelivered,
    replayDelivered,
    screenshot,
    posthogResponses,
  }, null, 2));

  await telemetry.shutdown(5000);
  win.destroy();
  fs.rmSync(userData, { recursive: true, force: true });
  app.quit();

  if (!result.feedbackConfirmed || !eventsDelivered || !replayDelivered) {
    process.exitCode = 1;
  }
}

app.whenReady().then(run).catch(async (error) => {
  console.error(error);
  await telemetry.shutdown(1000);
  app.quit();
  process.exitCode = 1;
});
