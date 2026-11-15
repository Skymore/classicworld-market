import assert from 'node:assert/strict';
import test from 'node:test';
import { viewportGap } from '../../frontend/src/lib/viewport-gap.ts';

test('the hidden strip under a stale iOS layout viewport lifts bottom-fixed UI', () => {
  const view = (height, offsetTop = 0, scale = 1) => ({ height, offsetTop, scale });
  assert.equal(viewportGap(874, view(874)), 0, 'normal: nothing hidden');
  assert.equal(viewportGap(874, view(873.5)), 0, 'rounding noise is ignored');
  assert.equal(viewportGap(874, view(780)), 94, 'stale viewport after the keyboard closed');
  assert.equal(viewportGap(874, view(780, 20)), 74, 'a scrolled visual viewport hides less');
  assert.equal(viewportGap(874, view(500), true), 0, 'while typing the keyboard owns the gap');
  assert.equal(viewportGap(874, view(400, 0, 2)), 0, 'a zoomed page is not a stale viewport');
  assert.equal(viewportGap(874, null), 0, 'no visualViewport');
});
