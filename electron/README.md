# OpenShorts desktop shell

This is a small wrapper that opens OpenShorts as a normal desktop app
window instead of a browser tab. It starts the same backend and video
renderer that `start-local.sh` starts, then shows them in a window.

## One-time setup

```bash
cd electron && npm install
```

You also need the Python environment and a built dashboard, same as
running the project any other way:

```bash
python3.11 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt
cd dashboard && npm run build
```

## Running it

```bash
cd electron && npm start
```

If `start-local.sh` (or another dev stack) is already running on port
8000, this app just opens a window pointed at it instead of starting a
second copy — nothing gets stopped or restarted underneath you.
