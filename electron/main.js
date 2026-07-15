// OpenShorts desktop shell (phase 1: "dev shell")
//
// Plain language version of what this file does:
//   Today you start OpenShorts by hand: activate the Python virtual
//   environment, start the backend server, start the video-render
//   service, then open a browser tab. This file does the same three
//   steps automatically and opens a normal desktop window instead of
//   a browser tab, so double-clicking one app does everything.
//
//   If you already have the stack running (e.g. via start-local.sh),
//   this shell notices that and just opens a window pointed at it,
//   instead of starting a second copy.
//
// This file intentionally mirrors start-local.sh. If you change how
// the backend or renderer are started there, update this file too.

const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BACKEND_URL = 'http://127.0.0.1:8000';
const RENDERER_PORT = 3100;

// Children we spawned ourselves. If we didn't spawn something (because
// it was already running), we must never try to kill it on quit.
const spawned = {
  backend: null,
  renderer: null,
};

// Keep a rolling tail of backend stderr so we can show something useful
// in the timeout error dialog if the backend never comes up.
const backendStderrTail = [];
function rememberBackendStderr(chunk) {
  const lines = chunk.toString().split('\n').filter(Boolean);
  for (const line of lines) {
    backendStderrTail.push(line);
    if (backendStderrTail.length > 20) backendStderrTail.shift();
  }
}

function fatal(title, message) {
  dialog.showErrorBox(title, message);
  app.quit();
  process.exit(1);
}

// --- Step 1: preflight checks -------------------------------------------

function runPreflightChecks() {
  const venvDir = path.join(ROOT, '.venv');
  if (!fs.existsSync(venvDir)) {
    fatal(
      'OpenShorts: missing Python environment',
      'The Python virtual environment (.venv) was not found.\n\n' +
        'To fix this, open a terminal in the project folder and run:\n\n' +
        '  python3.11 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt'
    );
    return false;
  }

  const dashboardIndex = path.join(ROOT, 'dashboard', 'dist', 'index.html');
  if (!fs.existsSync(dashboardIndex)) {
    fatal(
      'OpenShorts: dashboard not built',
      'The dashboard has not been built yet (dashboard/dist/index.html is missing).\n\n' +
        'To fix this, open a terminal in the project folder and run:\n\n' +
        '  cd dashboard && npm run build'
    );
    return false;
  }

  return true;
}

// --- Step 2: health check -------------------------------------------------

// Does a plain GET to url and resolves true only on HTTP 200 — anything
// else means whatever is on that port is not a healthy OpenShorts backend
// (e.g. some unrelated app that happens to occupy port 8000).
function checkUrlIsUp(url, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume(); // drain, we don't care about the body
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => {
      resolve(false);
    });
  });
}

// --- Step 3: spawn backend + renderer (mirrors start-local.sh 43-60) ------

function spawnStack() {
  // Honor OPENSHORTS_OUTPUT_DIR so the backend (which reads the same var) and
  // the renderer write to and serve from the same folder — they'd diverge if
  // only one side saw the override.
  const outputDir = process.env.OPENSHORTS_OUTPUT_DIR
    ? path.resolve(process.env.OPENSHORTS_OUTPUT_DIR)
    : path.join(ROOT, 'output');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // On darwin/linux, run children in their own process group (detached)
  // so we can kill the whole group later instead of just the immediate
  // child (uvicorn/npm often spawn their own children). On Windows, npm
  // is a shell script (npm.cmd), so spawning it needs shell: true.
  const groupOpts = process.platform === 'win32' ? { shell: true } : { detached: true };

  // Virtual environments put python in a different folder per platform.
  const pythonBin = process.platform === 'win32'
    ? path.join(ROOT, '.venv', 'Scripts', 'python.exe')
    : path.join(ROOT, '.venv', 'bin', 'python');

  console.log('Starting backend on ' + BACKEND_URL);
  const backend = spawn(
    pythonBin,
    ['-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', '8000'],
    {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        RENDER_SERVICE_URL: 'http://127.0.0.1:' + RENDERER_PORT,
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
      ...groupOpts,
    }
  );
  backend.stdout.on('data', (d) => process.stdout.write('[backend] ' + d));
  backend.stderr.on('data', (d) => {
    process.stderr.write('[backend] ' + d);
    rememberBackendStderr(d);
  });
  spawned.backend = backend;

  console.log('Starting renderer on http://127.0.0.1:' + RENDERER_PORT);
  const renderer = spawn('npm', ['run', 'dev'], {
    cwd: path.join(ROOT, 'render-service'),
    env: Object.assign({}, process.env, {
      OUTPUT_DIR: outputDir,
      REMOTION_BUNDLE_PATH: path.join(ROOT, 'remotion'),
      PORT: String(RENDERER_PORT),
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
    ...groupOpts,
  });
  renderer.stdout.on('data', (d) => process.stdout.write('[renderer] ' + d));
  const rendererStderrTail = [];
  renderer.stderr.on('data', (d) => {
    process.stderr.write('[renderer] ' + d);
    for (const line of d.toString().split('\n').filter(Boolean)) {
      rendererStderrTail.push(line);
      if (rendererStderrTail.length > 20) rendererStderrTail.shift();
    }
  });
  // We deliberately don't block the window on the renderer being ready
  // (its first startup can take a while bundling, and exports happen much
  // later) — but if it dies outright, say so instead of leaving the user
  // with a mysteriously broken Export button.
  renderer.on('exit', (code) => {
    spawned.renderer = null;
    if (quitting || code === 0) return;
    dialog.showErrorBox(
      'OpenShorts: video renderer stopped',
      'The video render service exited unexpectedly (code ' + code + ').\n' +
        'Exporting clips will not work until you restart the app.\n\nLast renderer output:\n\n' +
        (rendererStderrTail.join('\n') || '(no output captured)')
    );
  });
  spawned.renderer = renderer;
}

// --- Step 4: wait for the backend, then open the window --------------------

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForBackendThenShowWindow() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const up = await checkUrlIsUp(BACKEND_URL + '/api/config', 2000);
    if (up) {
      createWindow();
      return;
    }
    await wait(500);
  }

  const tail = backendStderrTail.length
    ? backendStderrTail.join('\n')
    : '(no backend output captured)';
  fatal(
    'OpenShorts: backend did not start',
    'Timed out after 60 seconds waiting for the backend at ' +
      BACKEND_URL +
      '/api/config.\n\nLast backend output:\n\n' +
      tail
  );
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'OpenShorts',
  });
  win.loadURL(BACKEND_URL);
}

// --- Step 5: clean shutdown --------------------------------------------

function killProcessGroup(child) {
  if (!child || child.killed || child.pid == null) return;
  try {
    if (process.platform === 'win32') {
      // child.kill() would only kill the wrapper shell and orphan the real
      // servers (leaking ports 8000/3100); taskkill removes the whole tree.
      spawn('taskkill', ['/pid', String(child.pid), '/f', '/t']);
    } else {
      // Negative pid = kill the whole process group we created with
      // `detached: true` above.
      process.kill(-child.pid, 'SIGTERM');
    }
  } catch (err) {
    // Process may already be gone; nothing more we can do.
  }
}

let quitting = false;
app.on('will-quit', () => {
  quitting = true;
  // Only kill what we actually spawned. If the stack was already
  // running before we started, leave it alone.
  killProcessGroup(spawned.backend);
  killProcessGroup(spawned.renderer);
});

app.on('window-all-closed', () => {
  app.quit();
});

// A Ctrl+C / kill from a terminal doesn't run Electron's quit events by
// itself, which would orphan the backend + renderer and leak their ports.
// Route those signals through the normal quit path so cleanup always runs.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => app.quit());
}

let starting = false;
app.on('activate', () => {
  // Guard against double-spawn if the user re-activates the app (e.g.
  // clicking the dock icon) while we're still starting up, or after all
  // windows were closed.
  if (starting) return;
  if (BrowserWindow.getAllWindows().length === 0) {
    starting = true;
    waitForBackendThenShowWindow().finally(() => {
      starting = false;
    });
  }
});

// --- Entry point ------------------------------------------------------

app.whenReady().then(async () => {
  if (!runPreflightChecks()) return;

  const alreadyUp = await checkUrlIsUp(BACKEND_URL + '/api/config', 1500);
  if (alreadyUp) {
    console.log('Backend already responding at ' + BACKEND_URL + ' — attaching instead of spawning.');
  } else {
    spawnStack();
  }

  await waitForBackendThenShowWindow();
});
