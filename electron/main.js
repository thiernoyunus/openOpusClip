// openOpusClip desktop shell
//
// Plain language version of what this file does:
//   openOpusClip is really three things: a Python backend server, a video
//   render service, and a web dashboard. Normally you'd start each by hand
//   and open a browser tab. This file starts them for you and opens a
//   normal desktop window instead, so one app does everything.
//
//   There are two modes:
//     * DEV mode (you run `npm start` from a source checkout): it uses your
//       project's .venv Python and `npm run dev` renderer, exactly like
//       start-local.sh. This mirrors start-local.sh — if you change how the
//       backend or renderer are started there, update this file too.
//     * PACKAGED mode (the built openOpusClip.app): everything it needs —
//       a portable Python, ffmpeg, the renderer, a headless browser — is
//       bundled inside the app. Nothing needs to be installed first.
//
//   In both modes, if the stack is already running (e.g. you started it in
//   a terminal), this shell notices and just opens a window pointed at it
//   instead of starting a second copy.

const { app, BrowserWindow, dialog, ipcMain, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const { autoUpdater } = require('electron-updater');
const { createTelemetry } = require('./telemetry');
const { categorizeUpdaterError } = require('./updater-categories');

const ROOT = path.resolve(__dirname, '..');
const BACKEND_URL = 'http://127.0.0.1:8000';
const RENDERER_PORT = 3100;

// In the built app, the staged runtime (Python, ffmpeg, renderer, browser,
// etc.) lands under the resources folder as `stage` — Contents/Resources/stage
// in the .app, resources\stage next to the .exe on Windows. See the
// electron-builder extraResources mapping in electron-builder.js. RES points
// there; DATA is the user's writable app-data folder (~/Library/Application
// Support/openOpusClip on macOS, %APPDATA%\openOpusClip on Windows). Both are
// only meaningful in packaged mode.
const PACKAGED = app.isPackaged;
// Without this, userData would be named after package.json's "name"
// (openopusclip-desktop); set it before the first getPath call so user data
// lives at ~/Library/Application Support/openOpusClip from the very first run.
app.setName('openOpusClip');
const RES = path.join(process.resourcesPath, 'stage');
const DATA = app.getPath('userData');

const IS_WIN = process.platform === 'win32';
// The portable CPython lays itself out differently per platform: the POSIX
// builds put the interpreter in python/bin/python3, the Windows build puts it
// at python/python.exe with no bin/ at all.
const STAGED_PYTHON = IS_WIN
  ? path.join(RES, 'python', 'python.exe')
  : path.join(RES, 'python', 'bin', 'python3');
const telemetry = createTelemetry({
  userData: DATA,
  appVersion: app.getVersion(),
  platform: process.platform,
  arch: process.arch,
  packaged: PACKAGED,
});

ipcMain.handle('open-opus-telemetry:get-context', () => telemetry.getContext());
ipcMain.handle('open-opus-telemetry:capture-feedback', (_event, feedback) => {
  if (!feedback || typeof feedback !== 'object') return false;
  return telemetry.capture('survey sent', feedback);
});

function launchErrorCategory(err) {
  if (err && err.code === 'ENOENT') return 'missing_executable';
  if (err && (err.code === 'EACCES' || err.code === 'EPERM')) return 'permission_denied';
  if (err && err.code === 'EADDRINUSE') return 'address_in_use';
  return 'process_launch_failed';
}

// uncaughtExceptionMonitor observes crashes without changing Node's normal
// crash behavior. Node reports an unhandled rejected promise here too, so we
// can distinguish it without installing a handler that would keep a broken
// process alive. The raw exception is deliberately never sent.
process.on('uncaughtExceptionMonitor', (_error, origin) => {
  telemetry.capture(
    origin === 'unhandledRejection'
      ? 'desktop_main_unhandled_rejection'
      : 'desktop_main_uncaught_exception',
    {
      stage: 'main_process',
      errorCategory: 'error',
    }
  );
});

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

async function fatal(title, message, pendingTelemetry) {
  // Kill children FIRST (before the modal blocks), then inform the user. The
  // process.exit() below skips the 'will-quit' handler, so without this a
  // fatal after spawnStack() leaks the backend/renderer process groups
  // (orphaned uvicorn/node holding ports 8000/3100).
  quitting = true;
  killProcessGroup(spawned.backend);
  killProcessGroup(spawned.renderer);
  dialog.showErrorBox(title, message);
  // Drain any pending telemetry before exiting so the fatal capture isn't
  // dropped on the floor by the synchronous process.exit() below.
  if (pendingTelemetry) {
    try {
      await Promise.race([
        pendingTelemetry,
        new Promise((resolve) => setTimeout(resolve, 750)),
      ]);
    } catch (_) { /* best-effort */ }
  }
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
      const pending = telemetry.capture('desktop_stack_startup_failed', {
        stage: 'preflight',
        errorCategory: 'missing_backend_bundle',
      });
      fatal(
        'openOpusClip: incomplete installation',
        'A required file is missing from the app bundle:\n\n' +
          '  ' + appPy + '\n\n' +
          'The app may be damaged. Please reinstall openOpusClip.'
      , pending);
      return false;
    }
    const py = STAGED_PYTHON;
    if (!fs.existsSync(py)) {
      const pending = telemetry.capture('desktop_stack_startup_failed', {
        stage: 'preflight',
        errorCategory: 'missing_python_runtime',
      });
      fatal(
        'openOpusClip: incomplete installation',
        'The bundled Python runtime is missing:\n\n' +
          '  ' + py + '\n\n' +
          'The app may be damaged. Please reinstall openOpusClip.'
      , pending);
      return false;
    }
    return true;
  }

  const venvDir = path.join(ROOT, '.venv');
  if (!fs.existsSync(venvDir)) {
    const pending = telemetry.capture('desktop_stack_startup_failed', {
      stage: 'preflight',
      errorCategory: 'missing_python_environment',
    });
    fatal(
      'openOpusClip: missing Python environment',
      'The Python virtual environment (.venv) was not found.\n\n' +
        'To fix this, open a terminal in the project folder and run:\n\n' +
        (IS_WIN
          ? '  py -3.11 -m venv .venv && .venv\\Scripts\\activate && pip install -r requirements.txt'
          : '  python3.11 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt')
    , pending);
    return false;
  }

  const dashboardIndex = path.join(ROOT, 'dashboard', 'dist', 'index.html');
  if (!fs.existsSync(dashboardIndex)) {
    const pending = telemetry.capture('desktop_stack_startup_failed', {
      stage: 'preflight',
      errorCategory: 'missing_dashboard_build',
    });
    fatal(
      'openOpusClip: dashboard not built',
      'The dashboard has not been built yet (dashboard/dist/index.html is missing).\n\n' +
        'To fix this, open a terminal in the project folder and run:\n\n' +
        '  cd dashboard && npm run build'
    , pending);
    return false;
  }

  return true;
}

// --- Step 2: health check -------------------------------------------------

// Does a plain GET to url and resolves true only on HTTP 200 — anything
// else means whatever is on that port is not a healthy openOpusClip backend
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
  //
  // Default to the SAME user-data folder the packaged app uses. Both modes
  // serve the UI from 127.0.0.1:8000, so they share one browser origin and
  // therefore one saved project list. If dev pointed at ./output instead, every
  // project made by the installed app would 404 on open and get permanently
  // branded "Expired" in that shared list — even though its clips are sitting
  // safely on disk. One folder per app keeps the list and the files in sync.
  const outputDir = process.env.OPENSHORTS_OUTPUT_DIR
    ? path.resolve(process.env.OPENSHORTS_OUTPUT_DIR)
    : path.join(DATA, 'output');
  const uploadsDir = process.env.OPENSHORTS_UPLOAD_DIR
    ? path.resolve(process.env.OPENSHORTS_UPLOAD_DIR)
    : path.join(ROOT, 'uploads');

  for (const dir of [outputDir, uploadsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

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
        OPENSHORTS_OUTPUT_DIR: outputDir,
        OPENSHORTS_UPLOAD_DIR: uploadsDir,
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
  //
  // On macOS we don't bundle a separate Node — Electron *is* Node when launched
  // with ELECTRON_RUN_AS_NODE=1, so a tiny `node` shell script on PATH that
  // re-invokes this app in that mode is enough. Rewritten every launch because
  // process.execPath moves when the app updates or is relocated.
  //
  // Windows can't use that trick. yt-dlp finds the runtime with a PATHEXT scan
  // and then launches it through CreateProcess, which refuses to run a .cmd/.bat
  // wrapper — so the Windows stage ships a real node.exe in RES/bin instead
  // (see scripts/desktop/build-stage.ps1) and there is nothing to write here.
  if (!IS_WIN) {
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
  }

  const bundledBin = path.join(RES, 'bin'); // static ffmpeg + ffprobe
  // Drop empty segments so an unset process.env.PATH can't leave a trailing
  // delimiter — POSIX shells read that as "also search the current directory".
  const packagedPath = [bundledBin, binDir, process.env.PATH]
    .filter(Boolean)
    .join(path.delimiter);

  // The staged browser lives in a per-platform/per-architecture folder
  // (chrome-headless-shell-mac-arm64 / -mac-x64 / -win64), so derive it from the
  // running process instead of hardcoding one. Falls back to a scan so an
  // unexpected folder name surfaces as a renderer error rather than a silently
  // wrong path.
  const chromeShellRoot = path.join(RES, 'chrome-headless-shell');
  const chromeExeName = IS_WIN ? 'chrome-headless-shell.exe' : 'chrome-headless-shell';
  const chromeShellDir = IS_WIN
    ? 'chrome-headless-shell-win64'
    : 'chrome-headless-shell-mac-' + process.arch; // arm64 | x64
  let chromeExecutable = path.join(chromeShellRoot, chromeShellDir, chromeExeName);
  if (!fs.existsSync(chromeExecutable)) {
    const found = (fs.existsSync(chromeShellRoot) ? fs.readdirSync(chromeShellRoot) : [])
      .map((entry) => path.join(chromeShellRoot, entry, chromeExeName))
      .find((candidate) => fs.existsSync(candidate));
    if (found) chromeExecutable = found;
  }

  return {
    outputDir,
    backend: {
      command: STAGED_PYTHON,
      args: ['-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', '8000'],
      cwd: path.join(RES, 'backend'),
      env: Object.assign({}, process.env, {
        // ffmpeg/ffprobe (bundled bin) + the yt-dlp node shim, ahead of the
        // inherited PATH.
        PATH: packagedPath,
        // The app bundle is signed and must stay byte-for-byte unchanged after
        // installation. Python may read the bundled bytecode cache, but must
        // never rewrite it inside Contents/Resources.
        PYTHONDONTWRITEBYTECODE: '1',
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
  // child (uvicorn/npm often spawn their own children). Windows has no
  // process groups we can address that way; killProcessGroup uses
  // `taskkill /t` there instead, which walks the tree from the direct child.
  //
  // Deliberately NOT `shell: true` here. Routing through cmd.exe would mean
  // hand-quoting every argument — and the very first one is an install path
  // ("C:\Program Files\openOpusClip\...", or any user folder with a space in
  // it), which cmd would split on the space and fail to launch. windowsHide
  // keeps a console window from flashing up behind the app on each launch.
  const groupOpts = IS_WIN ? { windowsHide: true } : { detached: true };

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
    const pending = telemetry.capture('desktop_backend_startup_failed', {
      stage: 'backend_spawn',
      errorCategory: launchErrorCategory(err),
    });
    fatal(
      'openOpusClip: backend failed to start',
      'Could not launch the backend process:\n\n  ' + err.message +
        '\n\nThe app may be damaged. Please reinstall openOpusClip.'
    , pending);
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
    // A non-zero exit can just mean port 8000 was already held by another valid
    // openOpusClip backend our 1.5s startup probe missed under load. Re-check
    // health before giving up: if a backend is answering, drop our dead
    // duplicate and let the wait loop attach to the existing one instead of
    // killing the app.
    checkUrlIsUp(BACKEND_URL + '/api/config', 2000).then((up) => {
      if (up) { spawned.backend = null; return; }
      const pending = telemetry.capture('desktop_backend_exited', {
        stage: 'backend_runtime',
        errorCategory: signal ? 'fault_signal' : 'nonzero_exit',
        exitCode: code,
        signal,
      });
      fatal(
        'openOpusClip: backend stopped',
        'The backend exited unexpectedly (' + (signal ? 'signal ' + signal : 'code ' + code) + ').\n\n' +
          'Last backend output:\n\n' + (backendStderrTail.join('\n') || '(no output captured)')
      , pending);
    });
  });
  spawned.backend = backend;

  console.log('Starting renderer on http://127.0.0.1:' + RENDERER_PORT);
  // Dev mode only: the renderer there is `npm run dev`, and npm on Windows is
  // npm.cmd — a batch file, which needs a shell to run. Packaged mode runs
  // Electron-as-Node directly and takes the plain options above.
  const rendererGroupOpts =
    IS_WIN && plan.renderer.shellOnWindows
      ? { shell: true, windowsHide: true }
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
  function showRendererDown(detail, telemetryDetails) {
    if (quitting || rendererReported) return;
    rendererReported = true;
    telemetry.capture(telemetryDetails.event, telemetryDetails.properties);
    dialog.showErrorBox(
      'openOpusClip: video renderer stopped',
      detail + '\nExporting clips will not work until you restart the app.\n\n' +
        'Last renderer output:\n\n' +
        (rendererStderrTail.join('\n') || '(no output captured)')
    );
  }
  function reportRendererDown(detail, telemetryDetails) {
    if (quitting || rendererReported) return;
    // Before the window opens, probe the RENDERER's own health — not the
    // backend's. A responding renderer on 3100 means an already-running
    // instance owns the port and we're attaching to it (duplicate launch), so
    // our dead duplicate is harmless. If nothing answers 3100, our renderer
    // really did fail (e.g. a port conflict with an unrelated process) and the
    // user needs to know exports are broken. After the window is open, any
    // renderer death is a genuine in-session crash.
    if (!windowOpen) {
      checkUrlIsUp('http://127.0.0.1:' + RENDERER_PORT + '/health', 2000).then((up) => {
        if (!up) showRendererDown(detail, telemetryDetails);
      });
      return;
    }
    showRendererDown(detail, telemetryDetails);
  }
  renderer.on('error', (err) => {
    spawned.renderer = null;
    reportRendererDown(
      'The video render service could not be launched:\n\n  ' + err.message + '\n',
      {
        event: 'desktop_render_service_startup_failed',
        properties: {
          stage: 'render_service_spawn',
          errorCategory: launchErrorCategory(err),
        },
      }
    );
  });
  renderer.on('exit', (code, signal) => {
    spawned.renderer = null;
    // Clean exit, or a "please stop" signal — our own shutdown kill, an OS
    // logout/restart, or someone terminating the process. None of these is a
    // renderer *crash*, so don't alarm the user. A real crash shows up as a
    // non-zero exit code or a fault signal (SIGSEGV/SIGABRT/SIGKILL-on-OOM).
    if (code === 0 || signal === 'SIGTERM' || signal === 'SIGINT' || signal === 'SIGHUP') return;
    const how = signal ? 'signal ' + signal : 'code ' + code;
    reportRendererDown(
      'The video render service exited unexpectedly (' + how + ').\n',
      {
        event: 'desktop_render_service_exited',
        properties: {
          stage: 'render_service_runtime',
          errorCategory: signal ? 'fault_signal' : 'nonzero_exit',
          exitCode: code,
          signal,
        },
      }
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
  const pending = telemetry.capture('desktop_backend_startup_failed', {
    stage: 'backend_healthcheck',
    errorCategory: 'health_check_timeout',
  });
  fatal(
    'openOpusClip: backend did not start',
    'Timed out after 60 seconds waiting for the backend at ' +
      BACKEND_URL +
      '/api/config.\n\nLast backend output:\n\n' +
      tail
  , pending);
}

function createWindow() {
  windowOpen = true;
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'openOpusClip',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return;
    const reasonCategories = {
      crashed: 'process_crashed',
      'abnormal-exit': 'process_crashed',
      killed: 'process_killed',
      'oom': 'out_of_memory',
      'launch-failed': 'launch_failed',
      'integrity-failure': 'integrity_failure',
      unresponsive: 'unresponsive',
    };
    telemetry.capture('desktop_render_process_gone', {
      stage: 'renderer_process',
      errorCategory: reasonCategories[details.reason] || 'unknown',
      exitCode: details.exitCode,
    });
  });
  win.loadURL(BACKEND_URL);

  // An update found during startup (before any window existed) is held until
  // now. Wait for the page so the prompt doesn't land on a blank window.
  win.webContents.once('did-finish-load', () => {
    if (pendingUpdate) promptForUpdate(pendingUpdate);
  });
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

// True while the process group still exists. Signal 0 performs the permission
// and existence check without actually sending anything.
function processGroupAlive(child) {
  if (!child || child.pid == null) return false;
  try {
    process.kill(process.platform === 'win32' ? child.pid : -child.pid, 0);
    return true;
  } catch (err) {
    return false;
  }
}

// Poll until every group is gone, or the timeout expires. On timeout the
// stragglers get SIGKILL: a slow child must not block an update restart
// forever, but neither should we hand over while it still owns a port.
async function waitForProcessGroupsToExit(children, timeoutMs) {
  const alive = children.filter(Boolean);
  if (alive.length === 0) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive.some(processGroupAlive)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  for (const child of alive.filter(processGroupAlive)) {
    try {
      process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL');
    } catch (err) {
      // Already gone between the check and the signal.
    }
  }
}

// Flips true once the app window is showing. Before that we may be racing a
// duplicate launch (an existing instance holds the ports); after it, a child
// dying is a genuine in-session failure.
let windowOpen = false;

let quitting = false;
let installingUpdate = false;
let telemetryShutdownStarted = false;
app.on('before-quit', (event) => {
  // quitAndInstall has already prepared its own install-and-relaunch exit.
  // Replacing that exit with a later ordinary app.quit() drops the update.
  if (installingUpdate) return;
  if (telemetryShutdownStarted) return;
  telemetryShutdownStarted = true;
  event.preventDefault();
  quitting = true;
  killProcessGroup(spawned.backend);
  killProcessGroup(spawned.renderer);
  telemetry.shutdown(750).finally(() => app.quit());
});

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

// --- Single instance ---------------------------------------------------
// Only one openOpusClip may run at a time. A second launch focuses the existing
// window and quits immediately. This is the structural guarantee that makes
// the rest of startup simple: we never race another copy of ourselves for
// ports 8000/3100, so the only stack that can already be running is a dev one
// (start-local.sh), which the attach check below handles.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}


// --- Auto-update (packaged mode only) --------------------------------

autoUpdater.autoDownload = false;
// On macOS, electron-updater emits its public "update-downloaded" event
// before Squirrel has staged the ZIP. Keep staging manual so Restart Now starts
// that native handoff deterministically instead of racing it in the background.
autoUpdater.autoInstallOnAppQuit = false;
autoUpdater.setFeedURL({
  provider: 'github',
  owner: 'thiernoyunus',
  repo: 'openOpusClip',
});

// electron-updater signals the same failure twice: the originating call
// (checkForUpdates / downloadUpdate) rejects AND an 'error' event fires. If
// both logged telemetry we'd double-count every failure (which is exactly what
// inflated the updater failure numbers). So the 'error' handler is the single
// reporter.
//
// Single-element stage buffer. electron-updater serializes its own
// operations, so at most one update operation is ever in flight per
// process. A manual "Check for Updates…" click mid-download must NOT
// clobber the in-flight 'updater_download' stage — otherwise an eventual
// download failure would be mis-reported as a check failure. pushUpdaterStage
// overwrites the stage only when the new operation is intended to run; the
// 'error' and 'update-not-available' handlers reset the stage to empty when
// the previous operation is known to have ended, so the next operation
// starts from a clean slate.
let updaterStage = 'updater_check';
function pushUpdaterStage(stage) {
  updaterStage = stage;
}
function currentUpdaterStage() {
  return updaterStage;
}

// GitHub can answer before the window exists: startup waits on the backend,
// which can take up to 60s on a cold launch. Remember the update and prompt
// once a window is available, otherwise the offer would be dropped silently
// and the user would never see it until some later launch.
let pendingUpdate = null;

// A small always-on-top overlay, not a change to the dashboard itself — the
// dock icon's progress fill is easy to miss (it's not where anyone is
// looking), and the multi-minute silence between "Download" and the next
// dialog otherwise reads as broken. This needs no IPC/renderer changes: it's
// a second BrowserWindow the main process fully owns and updates directly.
let updateHUD = null;

function showUpdateHUD(title) {
  const parent = BrowserWindow.getAllWindows()[0];
  const hud = new BrowserWindow({
    width: 360,
    height: 84,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    parent: parent || undefined,
    show: false,
    transparent: true,
    webPreferences: { contextIsolation: true },
  });
  if (parent) {
    const b = parent.getBounds();
    hud.setPosition(Math.round(b.x + (b.width - 360) / 2), Math.round(b.y + 72));
  }
  hud.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`
    <meta charset="utf-8">
    <style>
      @keyframes indeterminate {
        0%   { left: -35%; width: 35%; }
        60%  { left: 100%; width: 35%; }
        100% { left: 100%; width: 35%; }
      }
      #bar.indeterminate { position: absolute; width: 35%; animation: indeterminate 1.1s ease-in-out infinite; }
    </style>
    <body style="margin:0;height:100vh;background:#1a1a1a;color:#fff;font:12px -apple-system,sans-serif;text-align:center;padding:14px 18px;border-radius:10px;box-sizing:border-box;overflow:hidden;">
      <div id="t" style="margin-bottom:9px;">${title}</div>
      <div style="position:relative;background:#3a3a3a;border-radius:3px;height:6px;overflow:hidden;">
        <div id="bar" style="background:#6366f1;height:100%;width:0%;"></div>
      </div>
      <div id="sub" style="color:#999;margin-top:7px;">Starting...</div>
    </body>
  `));
  hud.once('ready-to-show', () => hud.show());
  updateHUD = {
    setTitle(t) { if (!hud.isDestroyed()) hud.webContents.executeJavaScript(`document.getElementById('t').textContent=${JSON.stringify(t)}`).catch(() => {}); },
    update(percent, subtitle) {
      if (hud.isDestroyed()) return;
      hud.webContents.executeJavaScript(
        `document.getElementById('bar').classList.remove('indeterminate');document.getElementById('bar').style.width='${percent}%';document.getElementById('sub').textContent=${JSON.stringify(subtitle)};`
      ).catch(() => {});
    },
    // For phases with no real percentage to report (the restart/install
    // wait) — a static bar frozen at 100% is indistinguishable from a hang.
    setBusy(subtitle) {
      if (hud.isDestroyed()) return;
      hud.webContents.executeJavaScript(
        `document.getElementById('bar').classList.add('indeterminate');document.getElementById('sub').textContent=${JSON.stringify(subtitle)};`
      ).catch(() => {});
    },
    // Returns a promise that resolves once the window is actually gone —
    // showing the next native dialog on the same parent while this is still
    // mid-close-animation is what made the restart prompt flash and vanish.
    close() {
      return new Promise((resolve) => {
        if (hud.isDestroyed()) return resolve();
        hud.once('closed', () => resolve());
        hud.close();
      });
    },
  };
  return updateHUD;
}

function promptForUpdate(info) {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) {
    pendingUpdate = info;
    return;
  }
  pendingUpdate = null;
  dialog.showMessageBox(win, {
    type: 'info',
    title: 'Update Available',
    message: `openOpusClip ${info.version} is available. Download it now?`,
    detail: 'The download runs in the background. The app restarts to finish installing.',
    buttons: ['Download', 'Later'],
    defaultId: 0,
    cancelId: 1,
  }).then(({ response }) => {
    if (response !== 0) return;
    pushUpdaterStage('updater_download');
    showUpdateHUD('Downloading update…');
    autoUpdater.downloadUpdate().catch(() => {
      // The 'error' handler reports this failure (with the real error); here we
      // only tidy the UI and swallow the rejection so it isn't unhandled.
      updateHUD?.close();
    });
  });
}

autoUpdater.on('update-available', promptForUpdate);

// The dock icon's progress fill is a nice-to-have, but it's easy to miss —
// the HUD is the feedback that actually answers "is this doing anything?".
autoUpdater.on('download-progress', (progress) => {
  const win = BrowserWindow.getAllWindows()[0];
  win?.setProgressBar(progress.percent / 100);
  const mb = (n) => (n / 1e6).toFixed(0);
  updateHUD?.update(progress.percent.toFixed(0), `${mb(progress.transferred)} MB / ${mb(progress.total)} MB`);
});

// Only show "up to date" when the user manually clicked Check for Updates.
// The startup check should be silent — nobody wants a dialog on every launch.
let _manualUpdateCheck = false;
autoUpdater.on('update-not-available', () => {
  if (!_manualUpdateCheck) return;
  _manualUpdateCheck = false;
  // check completed without an update; reset to the default so the next
  // operation doesn't carry a stale 'updater_check' label if it isn't a check.
  updaterStage = '';
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return;
  dialog.showMessageBox(win, {
    type: 'info',
    title: 'No Updates',
    message: 'openOpusClip is up to date.',
    buttons: ['OK'],
  });
});

// The single place updater failures are reported. electron-updater emits
// 'error' for every failure and hands us the actual error object here, so this
// is where we can attach a real category and code — the originating .catch()
// blocks only tidy up and swallow the rejection.
autoUpdater.on('error', (err) => {
  const failedStage = currentUpdaterStage();
  // The failing operation just ended. Reset the stage so the next
  // operation starts clean (pushUpdaterStage will set its own).
  updaterStage = '';
  installingUpdate = false;
  BrowserWindow.getAllWindows()[0]?.setProgressBar(-1);
  updateHUD?.close();
  telemetry.capture('desktop_updater_failed', {
    stage: failedStage,
    errorCategory: categorizeUpdaterError(err),
    error: err,
  });
  if (failedStage === 'updater_install') {
    dialog.showErrorBox(
      'Update could not be installed',
      'openOpusClip is still open and unchanged. Please try Check for Updates again.'
    );
  }
});

autoUpdater.on('update-downloaded', async (info) => {
  const win = BrowserWindow.getAllWindows()[0];
  win?.setProgressBar(-1);
  // Must finish before the next dialog opens on the same parent window —
  // starting them together made the restart prompt flash and vanish.
  await updateHUD?.close();
  const restartNow = async () => {
    // The kill-and-wait below can take a few seconds with nothing on screen
    // to show for it, which is exactly the "did it freeze?" gap that's easy
    // to mistake for a hang. Put the HUD back up immediately so there's no
    // silent stretch before the app visibly quits.
    showUpdateHUD('Installing update…').setBusy('Restarting the app…');
    // quitAndInstall bypasses 'will-quit', so the backend/renderer process
    // groups would be orphaned (holding ports 8000/3100) across the restart.
    quitting = true;
    killProcessGroup(spawned.backend);
    killProcessGroup(spawned.renderer);
    // SIGTERM only ASKS them to stop, and uvicorn shuts down gracefully, so the
    // ports can still be held when the updated app relaunches. It would then
    // find 8000 answering, assume a backend is already up, and attach to a
    // process that is about to exit — leaving the new app with no backend at
    // all. Wait for them to actually go before handing over.
    await waitForProcessGroupsToExit([spawned.backend, spawned.renderer], 10000);
    pushUpdaterStage('updater_install');
    // The normal before-quit handler replaces the requested quit with a later
    // app.quit() so telemetry can flush. That is correct for ordinary quits,
    // but it discards Squirrel's install-and-relaunch intent.
    installingUpdate = true;
    autoUpdater.quitAndInstall();
  };

  // Restarting unannounced mid-export would lose the user's work.
  if (!win) return restartNow();
  dialog.showMessageBox(win, {
    type: 'info',
    title: 'Update Ready',
    message: `openOpusClip ${info.version} is ready to install.`,
    detail: 'The app needs to restart. Finish any export in progress first.',
    buttons: ['Restart Now', 'Later'],
    defaultId: 0,
    cancelId: 1,
  }).then(({ response }) => {
    if (response === 0) restartNow();
  });
});


// --- Entry point ------------------------------------------------------

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return; // duplicate launch — already quit above
  if (!runPreflightChecks()) return;

  telemetry.capture('desktop_app_started', { stage: 'application' });

  // --- application menu with "Check for Updates…" -----------------------
  // Where this item belongs is a per-platform convention, and putting it in
  // the wrong place is immediately noticeable:
  //   macOS   — the first menu is the app name and holds About/Quit, with
  //             "Check for Updates…" right after About. Every Mac app does this.
  //   Windows — there is no app menu; updates live at the bottom of Help, and
  //             the app-name menu's Hide/Hide Others/Unhide roles don't exist
  //             at all. A Mac-shaped menu bar there just looks broken.
  //
  // Disabled while no update is available; the autoUpdater events flip it
  // on when a newer release is found.
  const updateMenuItem = {
    label: 'Check for Updates…',
    click: () => {
      _manualUpdateCheck = true;
      pushUpdaterStage('updater_check');
      // Reported by the 'error' handler; swallow the rejection here.
      autoUpdater.checkForUpdates().catch(() => {});
    },
  };
  if (app.isPackaged) {
    // Not wired to .enabled yet — always clickable. If nothing is
    // available the dialog just closes immediately, which matches
    // Safari / Chrome behaviour when you're already up to date.
  } else {
    // Hide the menu item in dev mode: there is no published release to
    // check against and it would just throw.
    updateMenuItem.visible = false;
  }
  const menuTemplate = IS_WIN
    ? [
        { label: 'File', submenu: [{ role: 'quit' }] },
        { role: 'editMenu' },
        { role: 'viewMenu' },
        { role: 'windowMenu' },
        { label: 'Help', submenu: [updateMenuItem, { type: 'separator' }, { role: 'about' }] },
      ]
    : [
        {
          label: app.name,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            updateMenuItem,
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        },
        { role: 'editMenu' },
        { role: 'viewMenu' },
        { role: 'windowMenu' },
      ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));

  if (app.isPackaged) {
    pushUpdaterStage('updater_check');
    // Reported by the 'error' handler; swallow the rejection here.
    autoUpdater.checkForUpdates().catch(() => {});
  }

  const alreadyUp = await checkUrlIsUp(BACKEND_URL + '/api/config', 1500);
  if (alreadyUp) {
    console.log('Backend already responding at ' + BACKEND_URL + ' — attaching instead of spawning.');
  } else {
    try {
      spawnStack();
    } catch (err) {
      telemetry.capture('desktop_stack_startup_failed', {
        stage: 'stack',
        errorCategory: 'stack_setup_failed',
      });
      throw err;
    }
  }

  await waitForBackendThenShowWindow();
});
