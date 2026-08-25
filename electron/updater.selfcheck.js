const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const Module = require('node:module');

class FakeWindow extends EventEmitter {
  constructor() {
    super();
    this.webContents = { executeJavaScript: () => Promise.resolve() };
  }

  isDestroyed() { return false; }
  loadURL() {}
  setPosition() {}
  show() {}
  close() { this.emit('closed'); }
}

FakeWindow.getAllWindows = () => [];

const app = new EventEmitter();
Object.assign(app, {
  isPackaged: false,
  getPath: () => '/tmp/openopusclip-updater-selfcheck',
  getVersion: () => 'selfcheck',
  quit() {},
  requestSingleInstanceLock: () => true,
  setName() {},
  whenReady: () => new Promise(() => {}),
});

const autoUpdater = new EventEmitter();
let quitAndInstallCalls = 0;
Object.assign(autoUpdater, {
  setFeedURL() {},
  quitAndInstall() { quitAndInstallCalls += 1; },
});

const originalLoad = Module._load;
const originalResourcesPath = process.resourcesPath;
process.resourcesPath = '/tmp/openopusclip-updater-selfcheck/resources';
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return {
      app,
      BrowserWindow: FakeWindow,
      dialog: { showErrorBox() {}, showMessageBox: () => Promise.resolve({ response: 1 }) },
      ipcMain: { handle() {} },
      Menu: {},
    };
  }
  if (request === 'electron-updater') return { autoUpdater };
  if (request === './telemetry') {
    return {
      createTelemetry: () => ({
        capture: () => Promise.resolve(true),
        getContext: () => ({}),
        shutdown: () => Promise.resolve(),
      }),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

require('./main');
Module._load = originalLoad;
process.resourcesPath = originalResourcesPath;

async function main() {
  assert.equal(autoUpdater.autoDownload, false);
  assert.equal(autoUpdater.autoInstallOnAppQuit, false);

  autoUpdater.emit('update-downloaded', { version: 'next' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(quitAndInstallCalls, 1, 'Restart Now must reach quitAndInstall');

  let prevented = false;
  app.emit('before-quit', { preventDefault() { prevented = true; } });
  assert.equal(prevented, false, 'the install-and-relaunch quit must not be replaced');

  autoUpdater.emit('error', new Error('install failed'));
  app.emit('before-quit', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true, 'an install error must restore normal quit handling');

  const source = require('node:fs').readFileSync(require.resolve('./main'), 'utf8');
  assert.match(source, /PYTHONDONTWRITEBYTECODE:\s*'1'/);
  console.log('updater self-check passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
