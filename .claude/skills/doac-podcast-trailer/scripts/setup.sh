#!/usr/bin/env bash
# One-time setup: Python deps, ffmpeg, caption fonts, face model.
# Everything cached in ~/.cache/doac-trailer so later runs skip it.
set -e
C="${DOAC_CACHE:-$HOME/.cache/doac-trailer}"; mkdir -p "$C/fonts"
python3 -m pip install -q faster-whisper opencv-python-headless numpy pillow gdown imageio-ffmpeg
if ! command -v ffmpeg >/dev/null; then
  F=$(python3 -c "import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())")
  ln -sf "$F" /usr/local/bin/ffmpeg 2>/dev/null || { mkdir -p "$HOME/.local/bin"; ln -sf "$F" "$HOME/.local/bin/ffmpeg"; echo "add ~/.local/bin to PATH"; }
fi
G=https://raw.githubusercontent.com/google/fonts/main/ofl
get() { [ -s "$C/fonts/$2" ] || curl -sSfL "$G/$1" -o "$C/fonts/$2"; }
get "montserrat/Montserrat%5Bwght%5D.ttf" Montserrat.ttf
get "anton/Anton-Regular.ttf" Anton-Regular.ttf
get "playfairdisplay/PlayfairDisplay-Italic%5Bwght%5D.ttf" PlayfairDisplay-Italic.ttf
[ -s "$C/yunet.onnx" ] || curl -sSfL https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx -o "$C/yunet.onnx"
echo "ready: $C"
