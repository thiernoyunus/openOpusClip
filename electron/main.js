// OpenShorts desktop shell
//
// Plain language version of what this file does:
//   OpenShorts is really three things: a Python backend server, a video
//   render service, and a web dashboard. Normally you'd start each by hand
//   and open a browser tab. This file starts them for you and opens a
//   normal desktop window instead, so one app does everything.
//
//   There are two modes:
//     * DEV mode (you run `npm start` from a source checkout): it uses your
//       project's .venv Python and `npm run dev` renderer, exactly like
//       start-local.sh. This mirrors start-local.sh — if you change how the
//       backend or renderer are started there, update this file too.
//     * PACKAGED mode (the built OpenShorts.app): everything it needs —
//       a portable Python, ffmpeg, the renderer, a headless browser — is
//       bundled inside the app. Nothing needs to be installed first.
//
//   In both modes, if the stack is already running (e.g. you started it in
//   a terminal), this shell notices and just opens a window pointed at it
//   instead of starting a second copy.

const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BACKEND_URL = 'http://127.0.0.1:8000';
const RENDERER_PORT = 3100;

// In the built app, the staged runtime (Python, ffmpeg, renderer, browser,
// etc.) lands at Contents/Resources/stage — see the electron-builder
// extraResources mapping in package.json. RES points there; DATA is the
// user's writable app-data folder (~/Library/Application Support/OpenShorts
// on macOS). Both are only meaningful in packaged mode.
const PACKAGED = app.isPackaged;
// Without this, userData would be named after package.json's "name"
// (openshorts-desktop); set it before the first getPath call so user data
// lives at ~/Library/Application Support/OpenShorts from the very first run.
app.setName('OpenShorts');
const RES = path.join(process.resourcesPath, 'stage');
const DATA = app.getPath('userData');

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
  // Kill children FIRST (before the modal blocks), then inform the user. The
  // process.exit() below skips the 'will-quit' handler, so without this a
  // fatal after spawnStack() leaks the backend/renderer process groups
  // (orphaned uvicorn/node holding ports 8000/3100).
  quitting = true;
  killProcessGroup(spawned.backend);
  killProcessGroup(spawned.renderer);
  dialog.showErrorBox(title, message);
  app.quit();
  process.exit(1);
}

// --- Step 1: preflight checks -------------------------------------------

function runPreflightChecks() {
  if (PACKAGED) {
    // In the built app the runtime is bundled; the only way these are
    // missing is a corrupt/incomplete build, so point the user at that.
    const appPy = path.join(RES, 'backend', 'app.py');
    if (!fs.existsSync(appPy)) {
      fatal(
        'OpenShorts: incomplete installation',
        'A required file is missing from the app bundle:\n\n' +
          '  ' + appPy + '\n\n' +
          'The app may be damaged. Please reinstall OpenShorts.'
      );
      return false;
    }
    const py = path.join(RES, 'python', 'bin', 'python3');
    if (!fs.existsSync(py)) {
      fatal(
        'OpenShorts: incomplete installation',
        'The bundled Python runtime is missing:\n\n' +
          '  ' + py + '\n\n' +
          'The app may be damaged. Please reinstall OpenShorts.'
      );
      return false;
    }
    return true;
  }

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

// --- Step 3: spawn backend + renderer -------------------------------------

// Build the two child-process descriptions for the current mode. Dev mode
// mirrors start-local.sh; packaged mode wires the bundled runtime. Keeping
// this in one place means the spawn/logging/cleanup plumbing below is shared.
function buildStackPlan() {
  if (PACKAGED) {
    return buildPackagedPlan();
  }
  return buildDevPlan();
}

function buildDevPlan() {
  // Honor OPENSHORTS_OUTPUT_DIR so the backend (which reads the same var) and
  // the renderer write to and serve from the same folder — they'd diverge if
  // only one side saw the override.
  const outputDir = process.env.OPENSHORTS_OUTPUT_DIR
    ? path.resolve(process.env.OPENSHORTS_OUTPUT_DIR)
    : path.join(ROOT, 'output');

  // Virtual environments put python in a different folder per platform.
  const pythonBin = process.platform === 'win32'
    ? path.join(ROOT, '.venv', 'Scripts', 'python.exe')
    : path.join(ROOT, '.venv', 'bin', 'python');

  return {
    outputDir,
    backend: {
      command: pythonBin,
      args: ['-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', '8000'],
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        RENDER_SERVICE_URL: 'http://127.0.0.1:' + RENDERER_PORT,
      }),
    },
    // In dev, the renderer is `npm run dev` (tsx watch). On Windows npm is a
    // shell script, so it needs a shell to run (handled in spawnStack).
    renderer: {
      command: 'npm',
      args: ['run', 'dev'],
      cwd: path.join(ROOT, 'render-service'),
      env: Object.assign({}, process.env, {
        OUTPUT_DIR: outputDir,
        REMOTION_BUNDLE_PATH: path.join(ROOT, 'remotion'),
        PORT: String(RENDERER_PORT),
      }),
      shellOnWindows: true,
    },
  };
}

function buildPackagedPlan() {
  const outputDir = path.join(DATA, 'output');
  const uploadsDir = path.join(DATA, 'uploads');
  const hfHome = path.join(DATA, 'hf-cache');
  const binDir = path.join(DATA, 'bin');

  // Writable folders the backend/renderer need. The bundled resources are
  // read-only (inside the .app), so all runtime output goes under DATA.
  for (const dir of [outputDir, uploadsDir, hfHome, binDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // yt-dlp shells out to `node` (>= 22) to solve YouTube's JS challenges.
  // We don't bundle a separate Node — Electron *is* Node when launched with
  // ELECTRON_RUN_AS_NODE=1. Drop a tiny `node` shim on PATH that re-invokes
  // this app in that mode. Rewritten every launch because process.execPath
  // moves when the app updates or is relocated.
  const nodeShim = path.join(binDir, 'node');
  // Single-quote and escape the path so an install location containing
  // shell-active characters (spaces are fine either way, but '$' or '`'
  // inside double quotes would otherwise be expanded/interpreted) is passed
  // through literally.
  const shellSafeExecPath = "'" + process.execPath.replace(/'/g, "'\\''") + "'";
  fs.writeFileSync(
    nodeShim,
    '#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec ' + shellSafeExecPath + ' "$@"\n'
  );
  fs.chmodSync(nodeShim, 0o755);

  const bundledBin = path.join(RES, 'bin'); // static ffmpeg + ffprobe
  // Drop empty segments so an unset process.env.PATH can't leave a trailing
  // delimiter — POSIX shells read that as "also search the current directory".
  const packagedPath = [bundledBin, binDir, process.env.PATH]
    .filter(Boolean)
    .join(path.delimiter);

  const chromeExecutable = path.join(
    RES,
    'chrome-headless-shell',
    'chrome-headless-shell-mac-arm64',
    'chrome-headless-shell'
  );

  return {
    outputDir,
    backend: {
      command: path.join(RES, 'python', 'bin', 'python3'),
      args: ['-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', '8000'],
      cwd: path.join(RES, 'backend'),
      env: Object.assign({}, process.env, {
        // ffmpeg/ffprobe (bundled bin) + the yt-dlp node shim, ahead of the
        // inherited PATH.
        PATH: packagedPath,
        OPENSHORTS_OUTPUT_DIR: outputDir,
        OPENSHORTS_UPLOAD_DIR: uploadsDir,
        HF_HOME: hfHome, // whisper model cache
        RENDER_SERVICE_URL: 'http://127.0.0.1:' + RENDERER_PORT,
      }),
    },
    // The renderer is plain Node (@remotion/renderer is pure JS + a browser
    // subprocess), so run its built server.js through Electron-as-Node.
    renderer: {
      command: process.execPath,
      args: [path.join(RES, 'render-service', 'dist', 'server.js')],
      cwd: path.join(RES, 'render-service'),
      env: Object.assign({}, process.env, {
        ELECTRON_RUN_AS_NODE: '1',
        PORT: String(RENDERER_PORT),
        OUTPUT_DIR: outputDir,
        REMOTION_PREBUILT_BUNDLE: path.join(RES, 'remotion-bundle'),
        REMOTION_BROWSER_EXECUTABLE: chromeExecutable,
      }),
    },
  };
}

function spawnStack() {
  const plan = buildStackPlan();

  if (!fs.existsSync(plan.outputDir)) {
    fs.mkdirSync(plan.outputDir, { recursive: true });
  }

  // On darwin/linux, run children in their own process group (detached)
  // so we can kill the whole group later instead of just the immediate
  // child (uvicorn/npm often spawn their own children). On Windows, npm
  // is a shell script (npm.cmd), so spawning it needs shell: true.
  const groupOpts = process.platform === 'win32' ? { shell: true } : { detached: true };

  console.log('Starting backend on ' + BACKEND_URL);
  const backend = spawn(plan.backend.command, plan.backend.args, {
    cwd: plan.backend.cwd,
    env: plan.backend.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...groupOpts,
  });
  backend.stdout.on('data', (d) => process.stdout.write('[backend] ' + d));
  backend.stderr.on('data', (d) => {
    process.stderr.write('[backend] ' + d);
    rememberBackendStderr(d);
  });
  // If the executable itself can't be launched (missing/corrupt/bad perms),
  // Node emits 'error' — unhandled it would crash the whole app. The backend
  // is essential, so report it and quit cleanly instead of waiting out the
  // 60s health-check timeout.
  backend.on('error', (err) => {
    fatal(
      'OpenShorts: backend failed to start',
      'Could not launch the backend process:\n\n  ' + err.message +
        '\n\nThe app may be damaged. Please reinstall OpenShorts.'
    );
  });
  // The backend can also launch fine but exit immediately — port 8000 already
  // in use, a Python import error, etc. Fail fast with its output instead of
  // waiting out the 60s health-check timeout. (Our own shutdown sets quitting.)
  backend.on('exit', (code, signal) => {
    // Ignore clean exits and "please stop" signals (our shutdown, OS logout,
    // an external terminate) — only a real crash (non-zero code or fault
    // signal) should fail the app fast with its output.
    if (quitting || code === 0 ||
        signal === 'SIGTERM' || signal === 'SIGINT' || signal === 'SIGHUP') return;
    fatal(
      'OpenShorts: backend stopped',
      'The backend exited unexpectedly (' + (signal ? 'signal ' + signal : 'code ' + code) + ').\n\n' +
        'Last backend output:\n\n' + (backendStderrTail.join('\n') || '(no output captured)')
    );
  });
  spawned.backend = backend;

  console.log('Starting renderer on http://127.0.0.1:' + RENDERER_PORT);
  const rendererGroupOpts =
    process.platform === 'win32' && plan.renderer.shellOnWindows
      ? { shell: true }
      : groupOpts;
  const renderer = spawn(plan.renderer.command, plan.renderer.args, {
    cwd: plan.renderer.cwd,
    env: plan.renderer.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...rendererGroupOpts,
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
  // with a mysteriously broken Export button. A failed launch fires 'error'
  // (possibly followed by 'exit'); reportRendererDown de-dupes the two.
  let rendererReported = false;
  function reportRendererDown(detail) {
    spawned.renderer = null;
    if (quitting || rendererReported) return;
    rendererReported = true;
    dialog.showErrorBox(
      'OpenShorts: video renderer stopped',
      detail + '\nExporting clips will not work until you restart the app.\n\n' +
        'Last renderer output:\n\n' +
        (rendererStderrTail.join('\n') || '(no output captured)')
    );
  }
  renderer.on('error', (err) => {
    reportRendererDown('The video render service could not be launched:\n\n  ' + err.message + '\n');
  });
  renderer.on('exit', (code, signal) => {
    spawned.renderer = null;
    // Clean exit, or a "please stop" signal — our own shutdown kill, an OS
    // logout/restart, or someone terminating the process. None of these is a
    // renderer *crash*, so don't alarm the user. A real crash shows up as a
    // non-zero exit code or a fault signal (SIGSEGV/SIGABRT/SIGKILL-on-OOM).
    if (code === 0 || signal === 'SIGTERM' || signal === 'SIGINT' || signal === 'SIGHUP') return;
    const how = signal ? 'signal ' + signal : 'code ' + code;
    reportRendererDown('The video render service exited unexpectedly (' + how + ').\n');
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
