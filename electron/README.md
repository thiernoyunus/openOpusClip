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

The built `openOpusClip.app` bundles everything it needs — a portable Python,
ffmpeg, the renderer, and a headless browser — so nothing has to be
installed first.

Build the bundled runtime, then package it. The runtime is architecture
specific, so each target gets its own stage folder:

```bash
# Apple Silicon (arm64)
scripts/desktop/build-stage.sh --arch arm64   # -> desktop-stage/     (~2.7 GB)
cd electron && npm run package:arm64          # -> dist/openOpusClip-<ver>-arm64.dmg

# Intel (x64) — can be cross-built from an Apple Silicon Mac (needs Rosetta 2)
scripts/desktop/build-stage.sh --arch x64     # -> desktop-stage-x64/ (~2.7 GB)
cd electron && npm run package:x64            # -> dist/openOpusClip-<ver>-x64.dmg
```

`--arch` defaults to the machine you're on. `npm run package:both` builds both
DMGs in one go, but needs BOTH stage folders present (~5.4 GB) plus room for the
installers, so watch free disk.

Each packaging run produces **two** artifacts per architecture:

| Artifact | Purpose |
|---|---|
| `openOpusClip-<ver>-<arch>.dmg` | what people download and install |
| `openOpusClip-<ver>-<arch>.zip` | what auto-update installs from |
| `latest-mac.yml` | version metadata the updater reads |

Upload **all three** to the GitHub release. The updater ignores the DMG and
fails with `ERR_UPDATER_ZIP_FILE_NOT_FOUND` if the zip is missing, so a
DMG-only release installs fine but can never update itself.

`npm run package` still makes a plain `.app` (arm64, no installer) for quick
local testing.

### Code signing and notarization

Packaging signs the app automatically with the **Developer ID Application**
certificate in the login keychain — that is what lets other people run it
without macOS blocking it. Confirm the certificate is present with:

```bash
security find-identity -v -p codesigning   # look for "Developer ID Application"
```

Signing is what makes packaging slow (it signs every nested binary in the ~3 GB
runtime — expect roughly 10-20 minutes per architecture).

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

The app icon lives at `electron/build/icon.png` / `icon.icns`. Regenerate it
after changing the logo with:

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
