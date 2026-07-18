// Scale a normalized crop rect around its center by `factor` (>1 = bigger
// region = zoom OUT, <1 = tighter region = zoom IN), preserving the tile's
// locked aspect and clamping inside the [0,1] source bounds. Used by the
// Cmd+scroll preview zoom in PanelCropOverlay.
export function scaleCrop(crop, factor) {
    const cx = crop.x + crop.w / 2;
    const cy = crop.y + crop.h / 2;
    const r = crop.h / crop.w;            // aspect ratio, held constant
    const maxW = Math.min(1, 1 / r);      // widest region that still fits the frame
    const w = Math.min(maxW, Math.max(0.08, crop.w * factor)); // 0.08 = max zoom-in
    const h = w * r;
    const x = Math.min(1 - w, Math.max(0, cx - w / 2));
    const y = Math.min(1 - h, Math.max(0, cy - h / 2));
    return { x, y, w, h };
}
