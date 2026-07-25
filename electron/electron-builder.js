// electron-builder configuration.
//
// This is a .js config (not the "build" key in package.json) for one reason:
// the bundled runtime differs per architecture. `desktop-stage/` holds the
// arm64 runtime and `desktop-stage-x64/` the Intel one, and each .app must get
// exactly one of them. A static config cannot express that, and shipping the
// wrong stage produces an app that launches and then fails at the first
// ffmpeg/Python call.
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
//
// Signing: identity is left to electron-builder's automatic discovery, which
// picks the "Developer ID Application" cert from the login keychain. Set
// CSC_IDENTITY_AUTO_DISCOVERY=false to produce an unsigned build.

const path = require('node:path');

// electron-builder calls this for each target arch, so `arch` is authoritative;
// the env var is only a fallback for direct/manual invocations.
const stageForArch = (arch) => (arch === 'x64' ? '../desktop-stage-x64' : '../desktop-stage');

module.exports = {
  appId: 'com.openopusclip.desktop',
  productName: 'openOpusClip',
  asar: true,
  files: ['main.js', 'package.json'],

  // Resolved per-arch in the artifact hooks below.
  extraResources: [{ from: stageForArch(process.env.OPENSHORTS_TARGET_ARCH), to: 'stage' }],

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

  // Swap in the correct stage before each arch is packed. electron-builder reads
  // extraResources per-target, so mutating it here is what makes a single
  // `--arm64 --x64` invocation bundle the right runtime in each .app.
  beforePack: async (context) => {
    // Use builder-util's own enum->name mapping rather than comparing the
    // numeric Arch value by hand (ia32=0, x64=1, armv7l=2, arm64=3).
    const { Arch } = require('builder-util');
    const arch = Arch[context.arch];
    const from = stageForArch(arch);
    if (!['arm64', 'x64'].includes(arch)) {
      throw new Error(`unsupported target arch for staged runtime: ${arch}`);
    }
    context.packager.config.extraResources = [{ from, to: 'stage' }];
    console.log(`  • bundling runtime  arch=${arch} stage=${path.basename(from)}`);
  },
};
