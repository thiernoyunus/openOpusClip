import { useEffect, useState } from 'react';

/**
 * Client-generated thumbnail filmstrip: seeks an offscreen <video> through
 * `count` evenly spaced positions and captures small JPEG frames. Thumbnails
 * stream into state as they're captured so the strip fills progressively.
 */
export function useFilmstrip(sourceUrl, count = 14) {
    const [thumbs, setThumbs] = useState([]);

    useEffect(() => {
        if (!sourceUrl) return undefined;
        let cancelled = false;
        const video = document.createElement('video');
        video.src = sourceUrl;
        video.muted = true;
        video.playsInline = true;
        video.preload = 'auto';
        video.crossOrigin = 'anonymous';
        const canvas = document.createElement('canvas');

        const capture = async () => {
            const W = 96;
            const H = video.videoWidth > 0 ? Math.max(1, Math.round(W * (video.videoHeight / video.videoWidth))) : 54;
            canvas.width = W;
            canvas.height = H;
            const ctx = canvas.getContext('2d');
            const captured = [];
            for (let i = 0; i < count; i++) {
                if (cancelled) return;
                const t = ((i + 0.5) / count) * video.duration;
                await new Promise((resolve) => {
                    const onSeeked = () => {
                        video.removeEventListener('seeked', onSeeked);
                        resolve();
                    };
                    video.addEventListener('seeked', onSeeked);
                    video.currentTime = t;
                });
                if (cancelled) return;
                ctx.drawImage(video, 0, 0, W, H);
                captured.push(canvas.toDataURL('image/jpeg', 0.6));
                setThumbs([...captured]);
            }
        };

        video.addEventListener('loadedmetadata', capture, { once: true });
        video.addEventListener('error', () => {}, { once: true });

        return () => {
            cancelled = true;
            video.removeAttribute('src');
            video.load();
        };
    }, [sourceUrl, count]);

    return thumbs;
}

/**
 * Audio waveform peaks (0..1) for the timeline strip, decoded in the browser
 * with plain WebAudio. Returns null until ready, [] when the source has no
 * decodable audio.
 */
export function useWaveform(sourceUrl, buckets = 240) {
    const [peaks, setPeaks] = useState(null);

    useEffect(() => {
        if (!sourceUrl) return undefined;
        let cancelled = false;
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        fetch(sourceUrl)
            .then((res) => res.arrayBuffer())
            .then((buf) => ctx.decodeAudioData(buf))
            .then((audio) => {
                if (cancelled) return;
                if (audio.numberOfChannels === 0) {
                    setPeaks([]);
                    return;
                }
                const wave = audio.getChannelData(0);
                if (!wave || wave.length === 0) {
                    setPeaks([]);
                    return;
                }
                const per = Math.max(1, Math.floor(wave.length / buckets));
                const out = new Array(buckets).fill(0);
                for (let b = 0; b < buckets; b++) {
                    let max = 0;
                    const start = b * per;
                    const end = Math.min(start + per, wave.length);
                    for (let i = start; i < end; i += 16) {
                        const v = Math.abs(wave[i]);
                        if (v > max) max = v;
                    }
                    out[b] = max;
                }
                // Normalize so quiet clips still show structure
                const top = Math.max(0.001, ...out);
                setPeaks(out.map((v) => v / top));
            })
            .catch(() => {
                if (!cancelled) setPeaks([]);
            })
            .finally(() => ctx.close?.());
        return () => {
            cancelled = true;
        };
    }, [sourceUrl, buckets]);

    return peaks;
}
