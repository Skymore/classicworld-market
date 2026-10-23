// Loading, empty and error states shared by every page (base.css `.skel`,
// `.state`). Skeleton rows take the real row height so nothing jumps when
// data arrives; mob pictures appear only here and in decorations (plan v2 §4).
import { t } from './i18n.js';
import { esc, mobImg } from './format.js';

// Snail, blue snail, mushroom, slime: small enough for a 48 px slot.
const MOBS = [100100, 100101, 1110100, 210100];
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export function skeletonRows(n, height = 48) {
  return Array.from({ length: n }, () => `<div class="skel" style="--h:${height}px" aria-hidden="true"><i></i><i></i><i></i></div>`).join('')
    + `<span class="sr" role="status">${esc(t('common.loading'))}</span>`;
}

// `pick` chooses the mob so the same page always shows the same one.
export function emptyState(text = t('common.empty'), pick = 0) {
  const mob = MOBS[Math.abs(pick) % MOBS.length];
  return `<div class="state empty" role="status"><span class="mobpic"><img src="${mobImg(mob, reducedMotion() ? 'stand' : 'move')}" alt="" width="48" height="48"></span><p>${esc(text)}</p></div>`;
}

// Pair with `bindRetry`: the button carries data-retry.
export function errorState(text = t('common.error')) {
  return `<div class="state err" role="alert"><p>${esc(text)}</p><button type="button" class="btn" data-retry>${esc(t('common.retry'))}</button></div>`;
}

export function bindRetry(container, retry) {
  container.addEventListener('click', (e) => {
    if (e.target.closest('[data-retry]')) retry();
  });
}

// Hide a broken external picture (maplestory.io down) instead of a broken-image icon.
export function hideBrokenImages(container) {
  container.addEventListener('error', (e) => {
    if (e.target.tagName === 'IMG') e.target.style.visibility = 'hidden';
  }, true);
}
