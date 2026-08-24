# openOpusClip desktop shell

This wraps openOpusClip as a normal desktop app window. It starts the same
backend and video renderer the project uses, then shows them in a window.
It runs in one of two modes automatically.

## Dev mode (running from source)

Uses your project's `.venv` Python and the `npm run dev` renderer, just like
`start-local.sh`.

One-time setup:

```bash
cd electron && npm install
python3.11 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt
cd dashboard && npm run build
```

Run it:

```bash
cd electron && npm start
```

If the stack is already running on port 8000, the app just opens a window
pointed at it instead of starting a second copy.

## Packaged mode (the built app)

The built app bundles everything it needs — a portable Python, ffmpeg, the
renderer, and a headless browser — so nothing has to be installed first.

There are three builds: macOS Apple Silicon, macOS Intel, and Windows x64.
**The Mac ones are built here, the Windows one is built by CI** — see
[Windows](#windows) below for why.

Build the bundled runtime, then package it. The runtime is architecture
specific, so each target gets its own stage folder:

**For a real release, build both architectures in ONE `package:both` run:**

```bash
scripts/desktop/build-stage.sh --arch arm64   # -> desktop-stage/     (~2.0 GB)
scripts/desktop/build-stage.sh --arch x64     # -> desktop-stage-x64/ (~2.0 GB)
cd electron && npm run package:both           # both .dmg + .zip, one latest-mac.yml
```

This needs BOTH stage folders present (~4.0 GB) plus room for the installers, so
watch free disk. `--arch` defaults to the machine you're on, and the Intel stage
cross-builds from Apple Silicon via Rosetta 2.

> **Do not package the two architectures in separate runs for a release.**
> Both write the same `dist/latest-mac.yml`, and the second run OVERWRITES the
> first rather than merging — leaving metadata that lists only one architecture.
> The updater then filters that list by the Mac it is running on and finds
> nothing for the other architecture, so those users get
> `ERR_UPDATER_ZIP_FILE_NOT_FOUND` on every check and can never update.
> `package:both` writes a single file listing all four artifacts, which is what
> the updater expects.

Per-architecture runs are still fine for local testing, where the metadata is
unused:

```bash
cd electron && npm run package:arm64          # -> dist/openOpusClip-<ver>-arm64.{dmg,zip}
cd electron && npm run package:x64            # -> dist/openOpusClip-<ver>-x64.{dmg,zip}
```

Each packaging run produces **two** artifacts per architecture:

| Artifact | Purpose |
|---|---|
| `openOpusClip-<ver>-<arch>.dmg` | what people download and install |
| `openOpusClip-<ver>-<arch>.zip` | what auto-update installs from |
| `latest-mac.yml` | version metadata the updater reads (one file, both arches) |

Upload **all five** to the GitHub release — both DMGs, both zips, and the single
`latest-mac.yml`. The updater ignores the DMG and fails with
`ERR_UPDATER_ZIP_FILE_NOT_FOUND` if the matching zip is missing, so a DMG-only
release installs fine but can never update itself.

### Release notes (required)

Every release must explain what users will notice, not just say that a build
finished. Generate the source-change section from the commits between releases:

```bash
TAG=v1.0.12
NOTES_FILE=$(mktemp)
scripts/desktop/release-notes.sh "$TAG" > "$NOTES_FILE"
```

Before publishing, add the packaging result, signing/notarization status,
updater files, and any known limitations to the `Packaging and verification`
section, then attach it to the release:

```bash
gh release edit "$TAG" --notes-file "$NOTES_FILE"
rm "$NOTES_FILE"
```

The script keeps commit bodies under each change, grouped into features, fixes,
performance/reliability, and other work. The Windows tag workflow creates the
same detailed notes automatically; Mac releases must run this step after the
final artifacts are verified.

If you invoke electron-builder directly, pass **both** targets — a CLI target
list replaces the one in `electron-builder.js` rather than merging with it, so
`--mac dmg` silently drops the zip:

```bash
npx electron-builder --mac dmg zip --arm64
```

`npm run package` still makes a plain `.app` (arm64, no installer) for quick
local testing.

## Windows

The Windows installer is built by GitHub Actions, not on a Mac. electron-builder
could cross-build the installer itself, but the *runtime inside it* cannot be
cross-built: it holds a Windows CPython with compiled wheels (torch, mediapipe,
opencv) and Windows ffmpeg binaries. None of that can be assembled or
smoke-tested from macOS, so it runs where it will actually be used.

**To get a build:** Actions → **Desktop (Windows)** → *Run workflow*. It takes
around 40–60 minutes and leaves a downloadable `openOpusClip-windows-x64`
artifact containing the `.exe` and `latest.yml`. Nothing is published.

**To ship one:** tick *publish* when running the workflow, or push a `v*` tag.
Either uploads the installer and `latest.yml` to the matching GitHub release,
which is what the in-app updater reads.

`latest.yml` (Windows) and `latest-mac.yml` (macOS) are separate files, so a
Windows release and a Mac release can land on the same GitHub release without
overwriting each other's updater metadata. That is the trap described in the
macOS section, and it does not apply across platforms.

On a Windows machine you can also do it by hand:

```powershell
pwsh -File scripts/desktop/build-stage.ps1   # -> desktop-stage-win-x64\ (~2.5 GB)
cd electron; npm ci; npm run package:win     # -> dist\openOpusClip-<ver>-x64.exe
```

Two things differ from the macOS stage, both deliberate:

- **A real `node.exe` is bundled** (`stage/bin/node.exe`). yt-dlp needs Node ≥ 22
  to solve YouTube's JS challenges. macOS gets that for free — Electron *is*
  Node under `ELECTRON_RUN_AS_NODE=1`, so a one-line shell script on PATH is
  enough. Windows can't: yt-dlp finds the runtime with a PATHEXT scan and then
  launches it through `CreateProcess`, which refuses to run a `.cmd`/`.bat`
  wrapper. A shim is not an option there.
- **No hardware video encoding.** `ffmpeg_utils.py` only turns on VideoToolbox
  on macOS, so every Windows export goes through libx264 on the CPU. Exports
  will be slower than on a Mac. NVENC/QSV would fix that but needs per-GPU
  detection and a fallback path, which nothing has asked for yet.

### Windows code signing

Windows builds are **unsigned**. First launch shows a blue "Windows protected
your PC" SmartScreen box; people have to click *More info → Run anyway*. Worth
saying so on the download page.

Removing it needs a code-signing certificate (an OV cert builds reputation over
time; an EV cert clears SmartScreen immediately). With one in hand, set `CSC_LINK`
and `CSC_PASSWORD` as repository secrets and pass them through to the packaging
step — electron-builder picks them up with no config change.

### Code signing and notarization

Packaging signs the app automatically with the **Developer ID Application**
certificate in the login keychain — that is what lets other people run it
without macOS blocking it. Confirm the certificate is present with:

```bash
security find-identity -v -p codesigning   # look for "Developer ID Application"
```

Expect roughly **6-7 minutes per architecture**.

It used to be ~28 minutes. Two things fixed that, and both are easy to undo by
accident, so they're worth knowing:

1. `signIgnore` in `electron-builder.js` stops `codesign` from running on data
   files inside the bundled runtime. The signing tool otherwise launches one
   `codesign` process per file — ~40,000 of them, each making a network call to
   Apple's timestamp server — when only ~1,800 are actually executable code.
   The other files are still protected: the bundle seal hashes every one of
   them, and editing any file afterwards still fails verification.
2. `build-stage.sh` drops Python packages the app never runs (jax, sympy,
   onnxruntime, polars, networkx and friends — ~670 MB), so there is that much
   less to copy, sign, and compress.

If you add a Python dependency that ships a new kind of binary, check it still
gets signed rather than skipped.

To notarize as well — Apple's scan, which removes the "unidentified developer"
warning entirely — create an app-specific password at
[appleid.apple.com](https://appleid.apple.com/account/manage), put it in
`electron/.env` (git-ignored), and run the notarize step on the built app:

```bash
# electron/.env
APPLE_ID="you@example.com"
APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
```

```bash
# Notarize the installer people actually download (recommended).
node electron/scripts/notarize.js electron/dist/openOpusClip-<version>-<arch>.dmg

# With no argument it picks the most recent .dmg in dist/.
node electron/scripts/notarize.js
```

Passing a `.app` also works — the script zips it first, because Apple's notary
service only accepts `.zip`, `.pkg`, or `.dmg`. Notarizing the DMG is usually
what you want, since that is the file being distributed.

Confirm it worked (this is the check that reflects what a user's Mac does):

```bash
spctl -a -vvv /Volumes/openOpusClip*/openOpusClip.app
#   -> accepted
#      source=Notarized Developer ID
```

Set `CSC_IDENTITY_AUTO_DISCOVERY=false` to deliberately build unsigned.

The app icon lives at `electron/build/icon.png`, `icon.icns` (macOS) and
`icon.ico` (Windows). Regenerate all three after changing the logo with:

```bash
.venv/bin/python scripts/desktop/make-icon-from-image.py electron/build/source-logo.webp
```

### First launch notes

- A signed but **not yet notarized** build still shows a warning on first open.
  Right-click the app and choose **Open**, then confirm — once per machine.
  Notarizing (above) removes this step for everyone who downloads it.
- Your videos, uploads, and settings live in
  `~/Library/Application Support/openOpusClip` (output/, uploads/, hf-cache/).
  Deleting the app does not delete these.
- The first time you transcribe a video, the speech model downloads into
  `hf-cache/`. That first run is slower; later runs reuse the cached model.
