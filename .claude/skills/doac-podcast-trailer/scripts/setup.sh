#!/usr/bin/env bash
# One-time setup: Python deps, ffmpeg, caption fonts, face model, and HyperFrames (Node 22, Chrome, ffprobe).
# Everything is cached in ~/.cache/doac-trailer, so later runs skip what is already there.
# Writes ~/.cache/doac-trailer/env.sh: `source` it before running any `hyperframes` command.
set -e
C="${DOAC_CACHE:-$HOME/.cache/doac-trailer}"; mkdir -p "$C/fonts" "$C/bin"
python3 -m pip install -q faster-whisper opencv-python-headless numpy pillow gdown imageio-ffmpeg
if ! command -v ffmpeg >/dev/null; then
  F=$(python3 -c "import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())")
  ln -sf "$F" /usr/local/bin/ffmpeg 2>/dev/null || ln -sf "$F" "$C/bin/ffmpeg"
fi
G=https://raw.githubusercontent.com/google/fonts/main/ofl
get() { [ -s "$C/fonts/$2" ] || curl -sSfL "$G/$1" -o "$C/fonts/$2"; }
get "montserrat/Montserrat%5Bwght%5D.ttf" Montserrat.ttf
get "anton/Anton-Regular.ttf" Anton-Regular.ttf
get "playfairdisplay/PlayfairDisplay-Italic%5Bwght%5D.ttf" PlayfairDisplay-Italic.ttf
[ -s "$C/yunet.onnx" ] || curl -sSfL https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx -o "$C/yunet.onnx"

# ---------- HyperFrames: every trailer is built and rendered in it ----------
export PATH="$C/bin:$C/node/bin:$PATH"
fail() { echo "HYPERFRAMES NOT READY: $1"; echo "Use the Python fallback (render.py) and tell the person why."; exit 0; }

# Node 22+ (HyperFrames needs it). Downloaded into the cache if missing or too old.
major() { node -e 'console.log(process.versions.node.split(".")[0])' 2>/dev/null || echo 0; }
if [ "$(major)" -lt 22 ]; then
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) P=linux-x64 ;; Linux-aarch64) P=linux-arm64 ;; Darwin-arm64) P=darwin-arm64 ;; Darwin-x86_64) P=darwin-x64 ;;
    *) fail "no Node 22 build for $(uname -s)-$(uname -m)" ;;
  esac
  V=$(curl -sSfL https://nodejs.org/dist/index.json | python3 -c "import json,sys; print(next(r['version'] for r in json.load(sys.stdin) if r['version'].startswith('v22.')))") || fail "could not reach nodejs.org"
  rm -rf "$C/node"; mkdir -p "$C/node"
  curl -sSfL "https://nodejs.org/dist/$V/node-$V-$P.tar.gz" | tar -xz -C "$C/node" --strip-components=1 || fail "Node download failed"
fi

# HyperFrames itself: use one already on PATH, otherwise install it into the cache (with a portable ffprobe).
mkdir -p "$C/hf"
if [ ! -x "$C/hf/node_modules/.bin/hyperframes" ] || [ ! -e "$C/hf/node_modules/ffprobe-static" ]; then
  ( cd "$C/hf" && { [ -f package.json ] || echo '{"private": true}' > package.json; } && npm install --silent --no-fund --no-audit hyperframes ffprobe-static ) \
    || { command -v hyperframes >/dev/null || fail "npm install hyperframes failed"; }
fi
HF_BIN=$(command -v hyperframes 2>/dev/null || true)
case "$HF_BIN" in ""|"$C/bin/hyperframes") HF_BIN="$C/hf/node_modules/.bin/hyperframes" ;; esac
[ -x "$HF_BIN" ] || fail "hyperframes not found after install"
ln -sf "$HF_BIN" "$C/bin/hyperframes"
HF_PKG=$(python3 -c "import os,sys; p=os.path.realpath(sys.argv[1])
while p != '/' and not os.path.exists(os.path.join(p, 'package.json')): p = os.path.dirname(p)
print(p)" "$HF_BIN")

# ffprobe: HyperFrames probes every clip with it.
if ! command -v ffprobe >/dev/null; then
  FP=$(cd "$C/hf" && node -e 'console.log(require("ffprobe-static").path)' 2>/dev/null || true)
  [ -x "$FP" ] || fail "no ffprobe"
  ln -sf "$FP" "$C/bin/ffprobe"
fi

# Chrome for rendering: HyperFrames' own download, else a Chrome/Chromium already on the machine.
BROWSER=""
if ! hyperframes browser ensure >/dev/null 2>&1; then
  for b in /opt/pw-browsers/chromium_headless_shell-*/chrome-linux/headless_shell "$HOME"/.cache/ms-playwright/chromium_headless_shell-*/chrome-linux/headless_shell \
           "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" "$(command -v google-chrome || true)" "$(command -v chromium || true)"; do
    [ -x "$b" ] && { BROWSER="$b"; break; }
  done
  [ -n "$BROWSER" ] || fail "no Chrome: 'hyperframes browser ensure' could not download one"
fi

cat > "$C/env.sh" <<EOF
# made by setup.sh: puts hyperframes, ffprobe and Node 22 on PATH for this shell
export PATH="$C/bin:$C/node/bin:\$PATH"
export DOAC_HF_PKG="$HF_PKG"
EOF
[ -n "$BROWSER" ] && echo "export HYPERFRAMES_BROWSER_PATH=\"$BROWSER\"" >> "$C/env.sh"
echo "HyperFrames $(hyperframes --version) ready. Run: source $C/env.sh"
echo "ready: $C"
