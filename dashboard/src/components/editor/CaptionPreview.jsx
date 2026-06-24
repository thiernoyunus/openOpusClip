import React, { useEffect } from 'react';
import {
    getCaptionTemplate,
    resolveTemplateId,
} from '@remotion-src/lib/captionTemplates';
import { getFontStack, captionFontFaces } from '@remotion-src/lib/fonts';

/**
 * Static, accurate preview of a caption template — renders the template's real
 * `renderWord` (the same code the editor/export use) at a frozen frame, so the
 * highlight colour, outline, background and resting animation pose all show.
 * No Remotion <Player>; renderWord's helpers (interpolate/spring/random) are
 * pure functions of the frame/fps we pass in.
 *
 * ponytail: skips the block-level glow/drop-shadow filter (blockFilter lives
 * inside Subtitles.tsx and isn't exported). Core look is faithful; add the glow
 * here if a glow-heavy template looks flat in the chip.
 */

// A complete-enough base style; each template's defaultStyle overrides what matters.
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
const ACTIVE_INDEX = 1; // middle word carries the highlight treatment
const FPS = 30;
const FROZEN_FRAME = 30; // past every entrance animation → resting/settled pose

let fontsInjected = false;
function ensureFonts() {
    if (fontsInjected || typeof document === 'undefined') return;
    const el = document.createElement('style');
    el.id = 'caption-preview-fonts';
    el.textContent = captionFontFaces;
    document.head.appendChild(el);
    fontsInjected = true;
}

export default function CaptionPreview({ templateId, previewFontPx = 20, words = SAMPLE_WORDS }) {
    useEffect(ensureFonts, []);

    const template = getCaptionTemplate(resolveTemplateId({ template: templateId }));
    if (!template) return null;

    const style = { ...BASE_STYLE, ...template.defaultStyle, template: template.id };
    const fontStack = getFontStack(template.font ?? style.fontFamily);
    const uppercase = style.uppercase ?? template.uppercase ?? false;
    const containerStyle = template.containerStyle?.(style) ?? {};

    // Normalize every template to ~previewFontPx so chips are visually consistent
    // regardless of the template's real fontSize (56–96).
    const scale = previewFontPx / (style.fontSize || 56);

    // Emphasis word = the longest (drives size-contrast templates like Podcast).
    let emphasisIndex = 0;
    let longest = -1;
    words.forEach((w, i) => {
        if (w.length > longest) { longest = w.length; emphasisIndex = i; }
    });

    return (
        <span
            dir="auto"
            style={{
                display: 'inline-flex',
                transform: `scale(${scale})`,
                transformOrigin: 'center',
                gap: `${Math.round(style.fontSize * 0.28)}px`,
                alignItems: 'center',
                whiteSpace: 'nowrap',
                ...containerStyle,
            }}
        >
            {words.map((word, i) => (
                <React.Fragment key={i}>
                    {template.renderWord({
                        word,
                        isActive: i === ACTIVE_INDEX,
                        isPast: i < ACTIVE_INDEX,
                        frame: FROZEN_FRAME,
                        fps: FPS,
                        wordStartFrame: 0,
                        wordEndFrame: 12,
                        style,
                        fontStack,
                        uppercase,
                        seed: i * 17 + 3,
                        isEmphasis: i === emphasisIndex,
                    })}
                </React.Fragment>
            ))}
        </span>
    );
}
