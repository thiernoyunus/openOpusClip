import os
import platform


def video_codec_args(quality='intermediate', keyframe_interval=None):
    """ffmpeg video-encoder args, HW-accelerated on macOS.

    Uses VideoToolbox (h264_videotoolbox) on Darwin for a 3-10x speedup over
    libx264, unless OPENSHORTS_HWACCEL=0. Falls back to libx264 elsewhere.

    quality: 'final' (delivery) or 'intermediate' (cuts/edits, default).
    keyframe_interval: force a GOP size for dense keyframes (editor seek).
    """
    use_hw = platform.system() == 'Darwin' and os.environ.get('OPENSHORTS_HWACCEL', '1') != '0'
    if use_hw:
        # VideoToolbox is bitrate-driven, not CRF; these track the old CRF quality.
        args = ['-c:v', 'h264_videotoolbox', '-b:v', '12M' if quality == 'final' else '8M']
        if keyframe_interval:
            args += ['-g', str(keyframe_interval)]
        return args
    # ponytail: CPU fallback. veryfast/crf16 replaces the old ultrafast/crf12
    # intermediates (huge files) and medium/crf18 finals.
    if quality == 'final':
        args = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18']
    else:
        args = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16']
    if keyframe_interval:
        args += ['-g', str(keyframe_interval), '-keyint_min', str(keyframe_interval), '-sc_threshold', '0']
    return args
