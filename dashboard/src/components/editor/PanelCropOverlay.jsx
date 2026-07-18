import React, { useEffect, useRef, useState } from 'react';
import { Crop } from 'lucide-react';
import { EDITOR_FPS } from './EditorCanvas';
import { outputToSource, clipAtOutputFrame } from '@remotion-src/lib/edl';
import { panelsForLayout } from '@remotion-src/compositions/ReframedVideo';
import { autoPanelCrop, wholeFrameCrop } from './trackerMapping';
import { scaleCrop } from './cropZoom';
import ManualCropModal from './ManualCropModal';

const FULL_FRAME = { left: 0, top: 0, width: 1, height: 1 };

/**
 * Crop-by-clicking (Opus parity). With the Tracker OFF, clicking the canvas
 * selects a tile and offers a "Crop" button that opens the crop modal for that
 * tile's source region. Multi-panel layouts expose one tile per panel and edit
 * `panelCrops[i]`; fill/fit are single-tile and edit the whole-clip `manualCrop`
 * (the composition's fill/fit branches never look at panelCrops). Sits over the
 * Player, mutually exclusive with the Tracker overlay.
 */
export default function PanelCropOverlay({ playerRef, framing, dispatch, sourceUrl }) {
    const [outFrame, setOutFrame] = useState(0);
    // Selection is tagged with the clip it belongs to, so it self-invalidates
    // when the playhead moves to another clip (no reset effect / no setState in
    // an effect). { clipId, index } | null.
    const [sel, setSel] = useState(null);
    const [modalOpen, setModalOpen] = useState(false);
    const containerRef = useRef(null);
    // Latest context for the wheel listener (attached once), and the crop it's
    // mid-zoom on — dispatch is async, so consecutive wheel ticks read the
    // pending rect from here instead of stale props.
    const ctxRef = useRef(null);
    const pendingRef = useRef(null);

    useEffect(() => {
        const p = playerRef.current;
        if (!p) return;
        setOutFrame(p.getCurrentFrame());
        const onFrame = (e) => setOutFrame(e.detail.frame);
        p.addEventListener('frameupdate', onFrame);
        return () => p.removeEventListener('frameupdate', onFrame);
    }, [playerRef]);

    // Active clip resolved from the OUTPUT playhead (unambiguous under
    // reorder/duplication). Non-9:16 outputs drop the layout machinery
    // entirely, so there are no tiles to crop.
    const clip = clipAtOutputFrame(framing, outFrame, EDITOR_FPS)?.clip ?? null;
    const srcFrame = outputToSource(framing, outFrame, EDITOR_FPS);
    const outW = framing.outputWidth ?? 1080;
    const outH = framing.outputHeight ?? 1920;
    const is916 = Math.abs(outW / outH - 9 / 16) < 0.01;
    const active = !!clip && is916;

    // A whole-clip manual crop collapses the render to one full-canvas crop, so
    // its panels are gone until it's reset; fill/fit are single-tile by nature.
    const layoutPanels = active ? panelsForLayout(clip.layout, 1, 1) : [];
    const wholeFrame = active && (!!clip.manualCrop || layoutPanels.length === 1);
    const panels = wholeFrame ? [FULL_FRAME] : layoutPanels;
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

    // Keep the wheel listener's context fresh without re-attaching every frame.
    useEffect(() => {
        ctxRef.current = active ? { clip, wholeFrame, panels, srcFrame, framing, dispatch } : null;
    });

    // Cmd/Ctrl + scroll over the preview zooms the hovered tile's video in/out
    // (Opus parity). Native non-passive listener so we can preventDefault the
    // page scroll; re-attached only when `active` flips (the div is one stable
    // node for the whole active period, so clip changes don't need re-attach).
    useEffect(() => {
        const el = containerRef.current;
        if (!el) return undefined;
        const onWheel = (e) => {
            if (!e.ctrlKey && !e.metaKey) return; // plain scroll passes through
            const ctx = ctxRef.current;
            if (!ctx) return;
            e.preventDefault();
            const rect = el.getBoundingClientRect();
            const px = (e.clientX - rect.left) / rect.width;
            const py = (e.clientY - rect.top) / rect.height;
            const idx = ctx.panels.findIndex(
                (p) => px >= p.left && px <= p.left + p.width && py >= p.top && py <= p.top + p.height
            );
            if (idx < 0) return;
            const key = `${ctx.clip.id}:${idx}`;
            const stored = ctx.wholeFrame ? ctx.clip.manualCrop : ctx.clip.panelCrops?.[idx];
            const base =
                (pendingRef.current?.key === key ? pendingRef.current.crop : null) ||
                stored ||
                (ctx.wholeFrame
                    ? wholeFrameCrop(ctx.framing, ctx.clip, ctx.srcFrame)
                    : autoPanelCrop(ctx.framing, ctx.clip, idx, ctx.srcFrame));
            // deltaY > 0 (scroll down) widens the crop = zoom out; up = zoom in.
            const next = scaleCrop(base, Math.exp(e.deltaY * 0.001));
            pendingRef.current = { key, crop: next };
            ctx.dispatch(
                ctx.wholeFrame
                    ? { type: 'SET_MANUAL_CROP', clipId: ctx.clip.id, crop: next }
                    : { type: 'SET_PANEL_CROP', clipId: ctx.clip.id, panelIndex: idx, crop: next }
            );
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, [active]);

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
    // Panel rects are normalized, so this is the tile's true pixel aspect
    // (a full-frame tile yields the output aspect).
    const selAspect = selPanel ? (selPanel.width * outW) / (selPanel.height * outH) : 1;
    const currentCrop = (wholeFrame ? clip.manualCrop : clip.panelCrops?.[selected]) ?? null;

    const setCrop = (crop) =>
        dispatch(
            wholeFrame
                ? { type: 'SET_MANUAL_CROP', clipId: clip.id, crop }
                : { type: 'SET_PANEL_CROP', clipId: clip.id, panelIndex: selected, crop }
        );

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
                            className="pointer-events-auto absolute top-2 left-1/2 -translate-x-1/2 h-7 px-2.5 rounded-full bg-black/80 backdrop-blur-sm border border-white/15 text-xs text-white flex items-center gap-1.5 hover:bg-black transition-colors"
                        >
                            <Crop size={12} />
                            {currentCrop ? 'Adjust crop' : 'Crop'}
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
                    initialCrop={
                        currentCrop ||
                        (wholeFrame
                            ? wholeFrameCrop(framing, clip, srcFrame)
                            : autoPanelCrop(framing, clip, selected, srcFrame))
                    }
                    previewSec={srcFrame / framing.source.fps}
                    title={wholeFrame ? 'Crop this clip' : 'Crop this tile'}
                    subtitle={
                        wholeFrame
                            ? 'Choose how much of the video shows. Drag to move, use the corner to zoom.'
                            : 'Choose how much of this speaker shows in the tile. Drag to move, use the corner to zoom.'
                    }
                    aspectLabel={wholeFrame ? '9:16' : 'Tile'}
                    applyLabel="Apply crop"
                    onReset={currentCrop ? () => {
                        setCrop(null);
                        setModalOpen(false);
                        setSel(null);
                    } : null}
                    onApply={(crop) => {
                        setCrop(crop);
                        setModalOpen(false);
                    }}
                    onClose={() => setModalOpen(false)}
                />
            )}
        </>
    );
}
