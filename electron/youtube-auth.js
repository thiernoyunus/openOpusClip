// App-owned YouTube sign-in for yt-dlp.
//
// YouTube cookies cannot be returned to us by a normal system-browser visit,
// so this uses a persistent, isolated Electron session. The user signs in on
// YouTube's real page; only the resulting cookie jar is exported locally.

const { BrowserWindow, session, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const PARTITION = 'persist:youtube';
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:141.0) ' +
  'Gecko/20100101 Firefox/141.0';
const AUTH_COOKIES = ['SID', 'SAPISID', '__Secure-1PSID', '__Secure-3PSID', 'LOGIN_INFO'];

function cookieFilePath(dataDir) {
  return path.join(dataDir, 'youtube-cookies.txt');
}

function toNetscape(cookies) {
  const lines = [
    '# Netscape HTTP Cookie File',
    '# Written by openOpusClip. Do not edit.',
    '',
  ];
  for (const cookie of cookies) {
    lines.push([
      cookie.domain,
      cookie.domain.startsWith('.') ? 'TRUE' : 'FALSE',
      cookie.path || '/',
      cookie.secure ? 'TRUE' : 'FALSE',
      String(cookie.expirationDate ? Math.floor(cookie.expirationDate) : 0),
      cookie.name,
      cookie.value,
    ].join('\t'));
  }
  return lines.join('\n') + '\n';
}

function hasAuthCookie(cookies) {
  return cookies.some((cookie) => AUTH_COOKIES.includes(cookie.name));
}

async function exportCookies(dataDir) {
  const cookies = await session.fromPartition(PARTITION).cookies.get({});
  const file = cookieFilePath(dataDir);
  if (!hasAuthCookie(cookies)) {
    fs.rmSync(file, { force: true });
    return false;
  }

  fs.mkdirSync(dataDir, { recursive: true });
  const tempFile = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tempFile, toNetscape(cookies), { mode: 0o600 });
  fs.chmodSync(tempFile, 0o600);
  fs.renameSync(tempFile, file);
  return true;
}

function isSignedIn(dataDir) {
  return fs.existsSync(cookieFilePath(dataDir));
}

async function signOut(dataDir) {
  await session.fromPartition(PARTITION).clearStorageData();
  fs.rmSync(cookieFilePath(dataDir), { force: true });
}

function openSignInWindow(dataDir) {
  return new Promise((resolve) => {
    const partitionSession = session.fromPartition(PARTITION);
    partitionSession.setUserAgent(BROWSER_UA);

    const win = new BrowserWindow({
      width: 960,
      height: 800,
      title: 'Sign in to YouTube',
      autoHideMenuBar: true,
      webPreferences: {
        partition: PARTITION,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    win.webContents.setUserAgent(BROWSER_UA);
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:$/.test(new URL(url).protocol)) shell.openExternal(url);
      return { action: 'deny' };
    });
    win.loadURL('https://www.youtube.com/');

    win.on('closed', async () => {
      try {
        resolve(await exportCookies(dataDir));
      } catch (error) {
        console.error('[youtube-auth] cookie export failed:', error.message);
        resolve(false);
      }
    });
  });
}

module.exports = {
  openSignInWindow,
  exportCookies,
  isSignedIn,
  signOut,
  cookieFilePath,
  hasAuthCookie,
  toNetscape,
};
