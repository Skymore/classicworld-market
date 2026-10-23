// Keep Tab inside an open modal (item drawer, phone filter sheet). Call from
// a keydown handler for Tab; elements that are hidden are skipped.
export function trapFocus(dialog, e) {
  const items = [...dialog.querySelectorAll('a[href], button, input, select, textarea, [tabindex="0"]')]
    .filter((el) => !el.disabled && el.offsetParent !== null);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (!dialog.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
  else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}
