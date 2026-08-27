// electron-builder configuration.
//
// This is a .js config (not the "build" key in package.json) for one reason:
// the bundled runtime differs per platform and architecture. `desktop-stage/`
// holds the macOS arm64 runtime, `desktop-stage-x64/` the macOS Intel one, and
// `desktop-stage-win-x64/` the Windows one. Each installer must get exactly one
// of them. A static config cannot express that, and shipping the wrong stage
// produces an app that launches and then fails at the first ffmpeg/Python call.
//
// The filename matters: electron-builder only auto-discovers
// `electron-builder.{yml,yaml,json,json5,toml,js,cjs,ts}`. Naming this
// `electron-builder.config.js` would make it load silently as if no config
// existed — no bundled runtime, no signing, no entitlements — so do not rename
// it without also passing --config.
//
// Build with:
//   npx electron-builder --mac dmg --arm64
//   npx electron-builder --mac dmg --x64
//   npx electron-builder --win nsis --x64      (on Windows — see below)
//
// Signing: on macOS the identity is left to electron-builder's automatic
// discovery, which picks the "Developer ID Application" cert from the login
// keychain. Set CSC_IDENTITY_AUTO_DISCOVERY=false to produce an unsigned build.
// Windows builds are unsigned for now — there is no code-signing certificate,
// so SmartScreen shows a "Windows protected your PC" warning on first run.
// That is expected; buying an EV/OV cert and setting CSC_LINK + CSC_KEY_PASSWORD
// is the only thing that removes it.
//
// The Windows installer must be BUILT ON WINDOWS. Not for electron-builder's
// sake (it can cross-build an NSIS installer fine) but because the staged
// runtime cannot be: it contains a Windows CPython with compiled wheels
// (torch, mediapipe, opencv) and a Windows ffmpeg, none of which can be
// assembled or smoke-tested from macOS. See .github/workflows/desktop-windows.yml.

const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

// Feed electron-builder's BUILT-IN notarization from electron/.env.
//
// electron-builder notarizes and staples the .app during packing (macPackager
// notarizeIfProvided -> @electron/notarize, which staples), i.e. BEFORE the
// .dmg and .zip are built from it. That ordering is the whole point: every
// artifact then carries the ticket, and latest-mac.yml is generated from the
// final files.
//
// It reads process.env only, and its password variable is
// APPLE_APP_SPECIFIC_PASSWORD. electron/.env uses the shorter
// APP_SPECIFIC_PASSWORD (scripts/notarize.js reads that name), so without this
// mapping electron-builder finds no credentials, logs "skipped macOS
// notarization", and happily ships unstapled artifacts. 1.0.17 was built that
// way and needed the DMGs notarized by hand afterwards.
const DEFAULT_TEAM_ID = '257JN3YM2Y';

const loadNotarizeCredentials = () => {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (!m) continue;
      const [, key, rawValue] = m;
      if (process.env[key]) continue; // a real env var always wins
      process.env[key] = rawValue.trim().replace(/^["']|["']$/g, '');
    }
  }
  // Map .env's name onto the one electron-builder actually reads.
  if (!process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APP_SPECIFIC_PASSWORD) {
    process.env.APPLE_APP_SPECIFIC_PASSWORD = process.env.APP_SPECIFIC_PASSWORD;
  }
  if (!process.env.APPLE_TEAM_ID) process.env.APPLE_TEAM_ID = DEFAULT_TEAM_ID;
};

loadNotarizeCredentials();

// Opt out deliberately (local test builds): OPENSHORTS_SKIP_NOTARIZE=1.
const notarizeSkipped = process.env.OPENSHORTS_SKIP_NOTARIZE === '1';

// electron-builder calls this for each target platform+arch, so both are
// authoritative; the env var is only a fallback for direct/manual invocations.
const stageFor = (platform, arch) => {
  if (platform === 'win32') return '../desktop-stage-win-x64';
  return arch === 'x64' ? '../desktop-stage-x64' : '../desktop-stage';
};

module.exports = {
  appId: 'com.openopusclip.desktop',
  productName: 'openOpusClip',
  asar: true,
  files: ['main.js', 'preload.js', 'telemetry.js', 'updater-categories.js', 'package.json'],

  // Resolved per-platform/arch in the beforePack hook below.
  extraResources: [
    {
      from: stageFor(process.env.OPENSHORTS_TARGET_PLATFORM, process.env.OPENSHORTS_TARGET_ARCH),
      to: 'stage',
    },
  ],

  mac: {
    category: 'public.app-category.video',
    // Required for notarization. The entitlements re-allow what Electron needs
    // (JIT, unsigned executable memory) plus the local backend/renderer sockets.
    hardenedRuntime: true,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',

    // Don't run `codesign` on data files inside the bundled runtime.
    //
    // This is the single biggest cost in packaging. @electron/osx-sign walks the
    // whole bundle and spawns one `codesign` process PER FILE, and each one makes
    // a network round-trip to Apple's timestamp server. Our staged runtime is
    // ~40,000 files, of which only ~420 are actual binaries (.so/.dylib/
    // extensionless executables). The other ~39,000 are Python source, bytecode
    // caches, C headers, and JSON — ~11,000 .py and ~10,000 .pyc alone. Signing
    // those individually is what turned packaging into a 10-20 minute job.
    //
    // Skipping them does NOT weaken the signature. Non-Mach-O files are not
    // independently signable in any meaningful sense; their integrity comes from
    // the bundle seal (_CodeSignature/CodeResources), which still hashes every
    // one of them when the top-level .app is signed at the end. `codesign
    // --verify --deep` and notarization both still pass.
    //
    // Scoped to /stage/ on purpose so Electron's own framework signing — which
    // does have real per-file requirements — is left exactly as it was.
    signIgnore: [
      '/stage/.*\\.(py|pyc|pyo|pyi|pyx|pxd)$',
      '/stage/.*\\.(h|hpp|hxx|inc|c|cc|cpp)$',
      '/stage/.*\\.(json|jsonl|ts|tsx|map|md|rst|txt|cfg|toml|ini|yaml|yml|xml)$',
      '/stage/.*\\.d\\.(ts|cts|mts)$',
      '/stage/.*\\.(gz|zip|whl|tar)$',
      '/stage/.*\\.(png|jpg|jpeg|gif|svg|ico|webp|ttf|otf|woff|woff2|icns)$',
      '/stage/.*\\.(csv|npy|npz|dat|pb|tflite|onnx|bin|pth|pt|model|vocab)$',
      '/stage/.*\\.(html|css|scss|less|mjs|cjs|js)$',
      '/stage/.*/(LICENSE|COPYING|NOTICE|AUTHORS|README|RECORD|METADATA|WHEEL|top_level|entry_points)[^/]*$',
    ],

    // ${arch} keeps the arm64 and x64 DMGs from overwriting each other.
    artifactName: '${productName}-${version}-${arch}.${ext}',
    // Both targets are required, for different jobs:
    //   dmg — the installer people download and drag to Applications.
    //   zip — what electron-updater installs FROM. MacUpdater looks for a zip
    //         and explicitly excludes dmg/pkg, throwing
    //         ERR_UPDATER_ZIP_FILE_NOT_FOUND without one, so a dmg-only
    //         release makes auto-update fail at download. Building zip here
    //         also produces the latest-mac.yml metadata the updater reads.
    //
    // CAUTION: a CLI target list REPLACES this, it does not merge. Running
    // `electron-builder --mac dmg --arm64` normalizes to arm64:[dmg] and the
    // zip below is silently skipped. That is why the npm scripts spell out
    // `--mac dmg zip`. Keep the two in sync, or invoke with `--mac` alone and
    // let this list apply.
    target: [
      { target: 'dmg', arch: ['arm64', 'x64'] },
      { target: 'zip', arch: ['arm64', 'x64'] },
    ],
  },

  win: {
    icon: 'build/icon.ico',
    // NSIS only. It is the one Windows target electron-updater can install
    // from, so a zip/portable-only release could never auto-update — the same
    // trap the mac zip note above describes.
    target: [{ target: 'nsis', arch: ['x64'] }],
    artifactName: '${productName}-${version}-${arch}.${ext}',
  },

  nsis: {
    // A wizard, not a one-click installer. The payload is ~2 GB, so silently
    // installing to AppData with no destination choice and no progress is a
    // bad first impression — people want to see where 2 GB is going.
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    // Per-user by default: a machine-wide install needs an admin prompt, and
    // the app writes nothing outside the user's own profile.
    perMachine: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'openOpusClip',
    // differentialPackage is left at its default (on). It writes the .blockmap
    // next to the installer, which lets electron-updater download only the
    // parts that changed. At this size that is the difference between a ~10 MB
    // update and re-downloading well over a gigabyte, so it must not be turned
    // off — and the .blockmap must be published alongside the .exe.
  },

  dmg: {
    title: 'openOpusClip ${version}',
    icon: 'build/icon.icns',
    window: { width: 540, height: 400 },
    contents: [
      { x: 130, y: 220 },
      { x: 410, y: 220, type: 'link', path: '/Applications' },
    ],
  },

  publish: { provider: 'github', owner: 'thiernoyunus', repo: 'openOpusClip' },

  // Swap in the correct stage before each target is packed. electron-builder
  // reads extraResources per-target, so mutating it here is what makes a single
  // `--arm64 --x64` invocation bundle the right runtime in each .app.
  // Refuse to ship a macOS build that was not notarized.
  //
  // The failure this guards is SILENT: with no credentials electron-builder
  // logs one "skipped macOS notarization" line among thousands and produces
  // artifacts that look fine. Every Mac then shows "Apple cannot check it for
  // malicious software" on first open. Asking the .app directly is the same
  // question a user's Mac asks, so it cannot pass while users would see a
  // warning.
  afterSign: async (context) => {
    if (context.electronPlatformName !== 'darwin') return;
    const appPath = path.join(
      context.appOutDir,
      `${context.packager.appInfo.productFilename}.app`
    );
    if (notarizeSkipped) {
      console.log(`  • notarization SKIPPED by OPENSHORTS_SKIP_NOTARIZE — do not release this build`);
      return;
    }
    try {
      execFileSync('xcrun', ['stapler', 'validate', appPath], { stdio: 'pipe' });
    } catch {
      throw new Error(
        `${path.basename(appPath)} has no stapled notarization ticket.\n` +
          'electron-builder logs this as a one-line "skipped macOS notarization" warning ' +
          'and keeps going, so check the log for it.\n' +
          'Usual cause: APPLE_ID / APP_SPECIFIC_PASSWORD missing from electron/.env.\n' +
          'For a deliberately unnotarized local build, set OPENSHORTS_SKIP_NOTARIZE=1.'
      );
    }
    console.log(`  • notarization ticket stapled  app=${path.basename(appPath)}`);
  },

  beforePack: async (context) => {
    // Use builder-util's own enum->name mapping rather than comparing the
    // numeric Arch value by hand (ia32=0, x64=1, armv7l=2, arm64=3).
    const { Arch } = require('builder-util');
    const arch = Arch[context.arch];
    const platform = context.electronPlatformName; // 'darwin' | 'win32' | 'linux'
    if (platform === 'win32' && arch !== 'x64') {
      throw new Error(`unsupported Windows target arch for staged runtime: ${arch}`);
    }
    if (platform === 'darwin' && !['arm64', 'x64'].includes(arch)) {
      throw new Error(`unsupported macOS target arch for staged runtime: ${arch}`);
    }
    if (!['darwin', 'win32'].includes(platform)) {
      throw new Error(`unsupported target platform for staged runtime: ${platform}`);
    }
    const from = stageFor(platform, arch);
    context.packager.config.extraResources = [{ from, to: 'stage' }];
    console.log(
      `  • bundling runtime  platform=${platform} arch=${arch} stage=${path.basename(from)}`
    );
  },
};
