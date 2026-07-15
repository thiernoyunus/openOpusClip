# OpenShorts desktop shell

This wraps OpenShorts as a normal desktop app window. It starts the same
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

The built `OpenShorts.app` bundles everything it needs — a portable Python,
ffmpeg, the renderer, and a headless browser — so nothing has to be
installed first.

Build the bundled runtime, then package it:

```bash
scripts/desktop/build-stage.sh     # produces desktop-stage/ (~2.7 GB)
cd electron && npm run package      # -> electron/dist/mac-arm64/OpenShorts.app
```

`npm run package:dmg` makes a `.dmg` installer instead of a plain `.app`.

### First launch notes

- The app is **unsigned**, so macOS will refuse to open it on a double-click
  the first time. Right-click the app and choose **Open**, then confirm — you
  only need to do this once.
- Your videos, uploads, and settings live in
  `~/Library/Application Support/OpenShorts` (output/, uploads/, hf-cache/).
  Deleting the app does not delete these.
- The first time you transcribe a video, the speech model downloads into
  `hf-cache/`. That first run is slower; later runs reuse the cached model.
