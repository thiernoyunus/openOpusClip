import React, { useEffect, useMemo, useRef } from 'react';
import { Player } from '@remotion/player';
import { ShortVideo } from '@remotion-src/compositions/ShortVideo';

/**
 * Wraps Remotion's Player component for real-time preview in modals.
 * Accepts the same ShortVideoProps interface as the Remotion composition.
 *
 * @param {object} props
 * @param {string} props.videoUrl - URL to the base clip video
 * @param {number} props.durationInSeconds - Video duration in seconds
 * @param {object|null} props.subtitles - SubtitleConfig or null
 * @param {object|null} props.hook - HookConfig or null
 * @param {object|null} props.effects - EffectsConfig or null
 * @param {string} [props.className] - Additional CSS classes
 * @param {boolean} [props.autoPlay] - Start playback on mount (default true)
 * @param {boolean} [props.loop] - Loop playback (default true)
 * @param {function} [props.onPlay] - Called with current time (s) when playback starts
 * @param {function} [props.onPause] - Called when playback pauses
 * @param {function} [props.onEnded] - Called when playback reaches the end (loop off)
 */
export default function RemotionPreview({
    videoUrl,
    durationInSeconds = 30,
    subtitles = null,
    hook = null,
    effects = null,
    className = '',
    autoPlay = true,
    loop = true,
    onPlay = null,
    onPause = null,
    onEnded = null,
}) {
    const fps = 30;
    const durationInFrames = Math.max(1, Math.round(durationInSeconds * fps));
    const playerRef = useRef(null);

    // Keep the latest callbacks in a ref so the listener effect can run once on
    // mount instead of re-subscribing every render (callers pass inline fns).
    const callbacksRef = useRef({ onPlay, onPause, onEnded });
    callbacksRef.current = { onPlay, onPause, onEnded };

    useEffect(() => {
        const player = playerRef.current;
        if (!player) return;
        const handlePlay = () => callbacksRef.current.onPlay && callbacksRef.current.onPlay(player.getCurrentFrame() / fps);
        const handlePause = () => callbacksRef.current.onPause && callbacksRef.current.onPause();
        const handleEnded = () => callbacksRef.current.onEnded && callbacksRef.current.onEnded();
        player.addEventListener('play', handlePlay);
        player.addEventListener('pause', handlePause);
        player.addEventListener('ended', handleEnded);
        return () => {
            player.removeEventListener('play', handlePlay);
            player.removeEventListener('pause', handlePause);
            player.removeEventListener('ended', handleEnded);
        };
    }, []);

    const inputProps = useMemo(
        () => ({
            videoUrl,
            durationInFrames,
            fps,
            width: 1080,
            height: 1920,
            subtitles,
            hook,
            effects,
        }),
        [videoUrl, durationInFrames, subtitles, hook, effects]
    );

    return (
        <div className={`w-full h-full ${className}`}>
            <Player
                ref={playerRef}
                component={ShortVideo}
                inputProps={inputProps}
                durationInFrames={durationInFrames}
                fps={fps}
                compositionWidth={1080}
                compositionHeight={1920}
                style={{
                    width: '100%',
                    height: '100%',
                }}
                controls
                autoPlay={autoPlay}
                loop={loop}
            />
        </div>
    );
}
