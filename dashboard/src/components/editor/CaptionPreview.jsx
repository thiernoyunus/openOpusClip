import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
    getCaptionTemplate,
    resolveTemplateId,
} from '@remotion-src/lib/captionTemplates';
import { getFontStack, captionFontFaces } from '@remotion-src/lib/fonts';

/**
 * Accurate preview of a caption template using the template's real `renderWord`
 * (the same code the editor/export use), so highlight colour, outline,
 * background and animation pose all match the finished clip.
 *
 * - The caption is laid out at its native font size, allowed to WRAP, then
 *   scaled to fit its parent box (measured) — so a big/long style shows every
 *   word instead of clipping. Give the parent an explicit width and height.
 * - `animate` runs the caption word-by-word on a loop (highlight walks across
 *   the words, entrance animations play) — used for the selected tile so you
 *   see how it behaves when it's on. Unselected tiles show a settled pose.
 *
 * ponytail: skips the block-level glow/drop-shadow filter (blockFilter lives
 * inside Subtitles.tsx and isn't exported). Core look is faithful.
 */

const BASE_STYLE = {
    template: 'classic-pop',
    fontFamily: 'Inter',
    fontSize: 56,
    fontColor: '#FFFFFF',
    highlightColor: '#FFDD00',
    borderColor: '#000000',
    borderWidth: 3,
    bgColor: '#000000',
    bgOpacity: 0,
    animation: 'pop',
    captionAnimation: 'none',
    wordAnimation: 'none',
    emojiAnimation: 'pop-in',
};

const SAMPLE_WORDS = ['To', 'get', 'started'];
const FPS = 30;
const FROZEN_FRAME = 30; // settled/resting pose for unselected tiles
const WORD_SECONDS = 0.5; // how long each word holds the highlight while animating
const TAIL_SECONDS = 1.0; // pause on the full line before the loop restarts

let fontsInjected = false;
function ensureFonts() {
    if (fontsInjected || typeof document === 'undefined') return;
    const el = document.createElement('style');
    el.id = 'caption-preview-fonts';
    el.textContent = captionFontFaces;
    document.head.appendChild(el);
    fontsInjected = true;
}

export default function CaptionPreview({ templateId, animate = false, words = SAMPLE_WORDS }) {
    useEffect(ensureFonts, []);
    const boxRef = useRef(null);
    const capRef = useRef(null);
    const [fit, setFit] = useState(0); // 0 until first measure → avoids a flash at scale 1
    const [frame, setFrame] = useState(FROZEN_FRAME);
    const [fontsReady, setFontsReady] = useState(false);

    const template = getCaptionTemplate(resolveTemplateId({ template: templateId }));

    // Re-fit once the bundled caption fonts finish loading (their real widths
    // differ from the fallback the first paint measured).
    useEffect(() => {
        let alive = true;
        document.fonts?.ready.then(() => alive && setFontsReady(true));
        return () => { alive = false; };
    }, []);

    // Animation loop: advance a frame counter over the caption's length, on a
    // loop. Only the selected tile animates, so this rAF is cheap.
    useEffect(() => {
        if (!animate || !template) { setFrame(FROZEN_FRAME); return; }
        const totalSec = words.length * WORD_SECONDS + TAIL_SECONDS;
        let raf, start;
        const tick = (t) => {
            if (start == null) start = t;
            const elapsed = ((t - start) / 1000) % totalSec;
            setFrame(elapsed * FPS);
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [animate, template, words.length]);

    // Scale the (wrapped) caption to fit its box. scrollWidth/Height ignore CSS
    // transforms, so the natural layout size is stable across animation frames
    // (templates animate via transforms) — measuring only when the template,
    // words, or loaded fonts change avoids per-frame layout thrashing.
    useLayoutEffect(() => {
        const box = boxRef.current, cap = capRef.current;
        if (!box || !cap) return;
        const bw = box.clientWidth, bh = box.clientHeight;
        const cw = cap.scrollWidth, ch = cap.scrollHeight;
        if (!bw || !bh || !cw || !ch) return;
        const next = Math.min(bw / cw, bh / ch, 1) * 0.94;
        setFit((prev) => (Math.abs(prev - next) > 0.005 ? next : prev));
    }, [templateId, words, fontsReady]);

    if (!template) return null;

    const style = { ...BASE_STYLE, ...template.defaultStyle, template: template.id };
    const fontStack = getFontStack(template.font ?? style.fontFamily);
    const uppercase = style.uppercase ?? template.uppercase ?? false;
    const containerStyle = template.containerStyle?.(style) ?? {};

    // Even per-word timing so the highlight walks the line while animating.
    const wordStart = (i) => i * WORD_SECONDS * FPS;
    const activeIndex = animate
        ? words.reduce((acc, _w, i) => (frame >= wordStart(i) ? i : acc), 0)
        : Math.floor(words.length / 2); // middle word carries the highlight when settled

    // Emphasis word = the longest (drives size-contrast templates like Podcast).
    let emphasisIndex = 0, longest = -1;
    words.forEach((w, i) => { if (w.length > longest) { longest = w.length; emphasisIndex = i; } });

    return (
        <div
            ref={boxRef}
            style={{
                width: '100%',
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                overflow: 'hidden',
            }}
            data-fonts-ready={fontsReady ? '1' : '0'}
        >
            <span
                ref={capRef}
                dir="auto"
                style={{
                    display: 'inline-flex',
                    flexWrap: 'wrap',
                    transform: `scale(${fit || 0.0001})`,
                    transformOrigin: 'center',
                    visibility: fit ? 'visible' : 'hidden',
                    gap: `${Math.round(style.fontSize * 0.12)}px ${Math.round(style.fontSize * 0.28)}px`,
                    alignItems: 'center',
                    justifyContent: 'center',
                    // Cap the line width so long captions wrap to 2–3 lines
                    // instead of one very wide line (which would scale tiny).
                    maxWidth: `${Math.round(style.fontSize * 5.5)}px`,
                    ...containerStyle,
                }}
            >
                {words.map((word, i) => (
                    <React.Fragment key={i}>
                        {template.renderWord({
                            word,
                            isActive: i === activeIndex,
                            isPast: i < activeIndex,
                            frame: animate ? frame : FROZEN_FRAME,
                            fps: FPS,
                            wordStartFrame: animate ? wordStart(i) : 0,
                            wordEndFrame: animate ? wordStart(i) + WORD_SECONDS * FPS : 12,
                            style,
                            fontStack,
                            uppercase,
                            seed: i * 17 + 3,
                            isEmphasis: i === emphasisIndex,
                        })}
                    </React.Fragment>
                ))}
            </span>
        </div>
    );
}
