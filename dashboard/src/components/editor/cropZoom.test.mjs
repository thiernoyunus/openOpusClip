// Run: node dashboard/src/components/editor/cropZoom.test.mjs
import assert from 'node:assert';
import { scaleCrop } from './cropZoom.js';

// zoom out grows the region, preserves aspect, stays in bounds
let c = scaleCrop({ x: 0.4, y: 0.4, w: 0.2, h: 0.3 }, 2);
assert.ok(c.w > 0.2 && c.h > 0.3, 'zoom out grows');
assert.ok(Math.abs(c.h / c.w - 0.3 / 0.2) < 1e-9, 'aspect held');
assert.ok(c.x >= 0 && c.y >= 0 && c.x + c.w <= 1 + 1e-9 && c.y + c.h <= 1 + 1e-9, 'in bounds');

// clamped to the frame, never beyond
c = scaleCrop({ x: 0, y: 0, w: 0.5, h: 0.5 }, 100);
assert.ok(c.w <= 1 && c.h <= 1, 'capped at full frame');

// zoom-in floor
c = scaleCrop({ x: 0.5, y: 0.5, w: 0.2, h: 0.2 }, 0.0001);
assert.ok(c.w >= 0.08, 'min zoom respected');

console.log('ok');
