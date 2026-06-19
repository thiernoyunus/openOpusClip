import React, { useRef, useState, useCallback, useEffect } from 'react';
import { X } from 'lucide-react';
import { centerCropRect } from './useEditorState';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Manual reframe window (Opus parity: crop icon / double-click → precise
 * framing). Shows the 16:9 SOURCE at the segment's first frame with a
 * draggable, resizable crop rect locked to the output aspect — working
 * directly in source coordinates, so no inverse-crop math is needed.
 */
export default function ManualCropModal({ sourceUrl, source, segment, onApply, onClose }) {
    const outputAspect = 9 / 16; // crop rect pixel aspect (w/h)
    const containerRef = useRef(null);
    const dragRef = useRef(null); // {mode: 'move'|'resize', startX, startY, startCrop}
    const [crop, setCrop] = useState(
        segment.manualCrop || centerCropRect(outputAspect, source.width, source.height)
    );

    const srcAspect = source.width / source.height;
    // Normalized width implied by a normalized height, preserving pixel aspect
    const widthForHeight = useCallback(
        (h) => (h * source.height * outputAspect) / source.width,
        [source.height, source.width, outputAspect]
    );

    const startDrag = (e, mode) => {
        e.preventDefault();
        e.stopPropagation();
        dragRef.current = {
            mode,
            startX: e.clientX,
            startY: e.clientY,
            startCrop: crop,
        };
        try {
            e.target.setPointerCapture?.(e.pointerId);
        } catch { /* synthetic or already-released pointer */ }
    };

    const onPointerMove = (e) => {
        const drag = dragRef.current;
        const container = containerRef.current;
        if (!drag || !container) return;
        const rect = container.getBoundingClientRect();
        const dx = (e.clientX - drag.startX) / rect.width;
        const dy = (e.clientY - drag.startY) / rect.height;
        const start = drag.startCrop;

        if (drag.mode === 'move') {
            setCrop({
                ...start,
                x: clamp(start.x + dx, 0, 1 - start.w),
                y: clamp(start.y + dy, 0, 1 - start.h),
            });
        } else {
            // Resize from the bottom-right corner, aspect locked via height
            let h = clamp(start.h + dy, 0.2, 1 - start.y);
            let w = widthForHeight(h);
            if (start.x + w > 1) {
                w = 1 - start.x;
                h = (w * source.width) / outputAspect / source.height;
            }
            setCrop({ ...start, w, h });
        }
    };

    const endDrag = () => {
        dragRef.current = null;
    };

    useEffect(() => {
        const onKey = (e) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                onClose();
            }
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [onClose]);

    return (
        <div className="fixed inset-0 z-[140] bg-black/80 backdrop-blur-sm flex items-center justify-center p-6 animate-[fadeIn_0.15s_ease-out]">
            <div className="bg-surface border border-edge rounded-2xl p-5 w-full max-w-3xl shadow-2xl" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-medium text-fg">Manual reframe</h3>
                    <button onClick={onClose} className="w-8 h-8 rounded-md flex items-center justify-center text-muted hover:text-fg hover:bg-white/5" aria-label="Close">
                        <X size={16} />
                    </button>
                </div>

                <div
                    ref={containerRef}
                    className="relative w-full bg-black rounded-lg overflow-hidden select-none touch-none"
                    style={{ aspectRatio: `${srcAspect}` }}
                    onPointerMove={onPointerMove}
                    onPointerUp={endDrag}
                    onPointerLeave={endDrag}
                >
                    <video
                        src={`${sourceUrl}#t=${((segment.sourceStart ?? segment.startFrame ?? 0) / source.fps).toFixed(2)}`}
                        preload="auto"
                        muted
                        playsInline
                        className="absolute inset-0 w-full h-full pointer-events-none"
                    />
                    {/* Dimmed outside-crop area */}
                    <div
                        className="absolute border-2 border-fg shadow-[0_0_0_9999px_rgba(0,0,0,0.55)] cursor-move"
                        style={{
                            left: `${crop.x * 100}%`,
                            top: `${crop.y * 100}%`,
                            width: `${crop.w * 100}%`,
                            height: `${crop.h * 100}%`,
                        }}
                        onPointerDown={(e) => startDrag(e, 'move')}
                    >
                        <span className="absolute -top-6 left-0 text-[10px] text-fg bg-black/60 px-1.5 py-0.5 rounded">9:16</span>
                        <div
                            className="absolute -bottom-1.5 -right-1.5 w-4 h-4 rounded-full bg-fg cursor-nwse-resize"
                            onPointerDown={(e) => startDrag(e, 'resize')}
                        />
                    </div>
                </div>

                <div className="flex items-center justify-end gap-2 mt-4">
                    <button
                        onClick={onClose}
                        className="px-3.5 py-2 rounded-lg text-xs font-medium text-muted border border-edge hover:bg-white/5 transition-colors"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={() => onApply({
                            x: Number(crop.x.toFixed(4)),
                            y: Number(crop.y.toFixed(4)),
                            w: Number(crop.w.toFixed(4)),
                            h: Number(crop.h.toFixed(4)),
                        })}
                        className="px-3.5 py-2 rounded-lg text-xs font-medium bg-fg text-[#18181b] hover:bg-white transition-colors"
                    >
                        Apply crop
                    </button>
                </div>
            </div>
        </div>
    );
}
