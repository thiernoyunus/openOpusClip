import React, { useEffect, useRef, useState } from 'react';
import { Crop } from 'lucide-react';
import { EDITOR_FPS } from './EditorCanvas';
import { outputToSource, clipAtOutputFrame } from '@remotion-src/lib/edl';
import { panelsForLayout } from '@remotion-src/compositions/ReframedVideo';
import { autoPanelCrop } from './trackerMapping';
import ManualCropModal from './ManualCropModal';

// Layouts with more than one tile — the only ones per-tile crop applies to.
const MULTI_PANEL = ['split', 'three', 'four', 'screenshare', 'gameplay'];

/**
 * Per-tile crop (Opus parity): with the Tracker OFF, clicking a tile in a
 * multi-panel 9:16 layout selects it and offers a "Crop" button that opens the
 * crop modal for THAT tile's source region. Sits over the Player, mutually
 * exclusive with the Tracker overlay (only mounted when trackerOn is false).
 */
export default function PanelCropOverlay({ playerRef, framing, dispatch, sourceUrl }) {
    const [outFrame, setOutFrame] = useState(0);
    // Selection is tagged with the clip it belongs to, so it self-invalidates
    // when the playhead moves to another clip (no reset effect / no setState in
    // an effect). { clipId, index } | null.
    const [sel, setSel] = useState(null);
    const [modalOpen, setModalOpen] = useState(false);
    const containerRef = useRef(null);

    useEffect(() => {
        const p = playerRef.current;
        if (!p) return;
        setOutFrame(p.getCurrentFrame());
        const onFrame = (e) => setOutFrame(e.detail.frame);
        p.addEventListener('frameupdate', onFrame);
        return () => p.removeEventListener('frameupdate', onFrame);
    }, [playerRef]);

    // Active clip resolved from the OUTPUT playhead (unambiguous under
    // reorder/duplication); per-tile crop only applies to multi-panel 9:16
    // clips that aren't already whole-clip manual-cropped.
    const clip = clipAtOutputFrame(framing, outFrame, EDITOR_FPS)?.clip ?? null;
    const srcFrame = outputToSource(framing, outFrame, EDITOR_FPS);
    const outW = framing.outputWidth ?? 1080;
    const outH = framing.outputHeight ?? 1920;
    const is916 = Math.abs(outW / outH - 9 / 16) < 0.01;
    const active = !!clip && !clip.manualCrop && is916 && MULTI_PANEL.includes(clip.layout);
    const panels = active ? panelsForLayout(clip.layout, 1, 1) : []; // normalized 0..1 tiles
    const selected = active && sel && sel.clipId === clip.id && sel.index < panels.length ? sel.index : null;

    // Escape / click-away deselects (but not while the modal owns the screen).
    // setSel here runs inside event callbacks, not in the effect body.
    useEffect(() => {
        if (selected == null || modalOpen) return;
        const onKey = (e) => { if (e.key === 'Escape') setSel(null); };
        const onDown = (e) => { if (!containerRef.current?.contains(e.target)) setSel(null); };
        window.addEventListener('keydown', onKey);
        window.addEventListener('pointerdown', onDown);
        return () => {
            window.removeEventListener('keydown', onKey);
            window.removeEventListener('pointerdown', onDown);
        };
    }, [selected, modalOpen]);

    if (!active) return null;

    const handleClick = (e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const x = (e.clientX - rect.left) / rect.width;
        const y = (e.clientY - rect.top) / rect.height;
        const idx = panels.findIndex(
            (p) => x >= p.left && x <= p.left + p.width && y >= p.top && y <= p.top + p.height
        );
        setModalOpen(false);
        setSel(idx >= 0 ? { clipId: clip.id, index: idx } : null);
    };

    const selPanel = selected != null ? panels[selected] : null;
    const selAspect = selPanel ? (selPanel.width * outW) / (selPanel.height * outH) : 1;

    return (
        <>
            <div
                ref={containerRef}
                onClick={handleClick}
                className="absolute inset-0 z-10 cursor-pointer"
                data-panel-crop-overlay
            >
                {selPanel && (
                    <div
                        className="absolute border-2 border-viral rounded-sm pointer-events-none"
                        style={{
                            left: `${selPanel.left * 100}%`,
                            top: `${selPanel.top * 100}%`,
                            width: `${selPanel.width * 100}%`,
                            height: `${selPanel.height * 100}%`,
                        }}
                    >
                        <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); setModalOpen(true); }}
                            className="pointer-events-auto absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 h-7 px-2.5 rounded-full bg-black/80 backdrop-blur-sm border border-white/15 text-xs text-white flex items-center gap-1.5 hover:bg-black transition-colors"
                        >
                            <Crop size={12} />
                            {clip.panelCrops?.[selected] ? 'Adjust crop' : 'Crop'}
                        </button>
                    </div>
                )}
            </div>

            {modalOpen && selected != null && (
                <ManualCropModal
                    sourceUrl={sourceUrl}
                    source={framing.source}
                    segment={clip}
                    aspect={selAspect}
                    initialCrop={clip.panelCrops?.[selected] ?? autoPanelCrop(framing, clip, selected, srcFrame)}
                    previewSec={srcFrame / framing.source.fps}
                    title="Crop this tile"
                    subtitle="Choose how much of this speaker shows in the tile. Drag to move, use the corner to zoom."
                    aspectLabel="Tile"
                    applyLabel="Apply crop"
                    onReset={clip.panelCrops?.[selected] ? () => {
                        dispatch({ type: 'SET_PANEL_CROP', clipId: clip.id, panelIndex: selected, crop: null });
                        setModalOpen(false);
                        setSel(null);
                    } : null}
                    onApply={(crop) => {
                        dispatch({ type: 'SET_PANEL_CROP', clipId: clip.id, panelIndex: selected, crop });
                        setModalOpen(false);
                    }}
                    onClose={() => setModalOpen(false)}
                />
            )}
        </>
    );
}
