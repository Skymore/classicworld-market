// iOS 26 home-screen apps (and some Safari builds) can keep a stale layout
// viewport after the keyboard closes: the visible area is shorter than the
// one position:fixed and the page height use, so the dock and bottom sheets
// sit below the screen and the end of the page cannot be scrolled into view.
// Measure that gap and expose it as --vv-gap; base.css lifts bottom-fixed UI
// by it and pads the page by the same amount. It stays 0 everywhere else.

/** The part of the layout viewport hidden below the visible area, in px. */
export function viewportGap(
  innerHeight: number,
  view: { height: number; offsetTop: number; scale: number } | null | undefined,
  editing: boolean,
) {
  if (!view || editing || Math.abs(view.scale - 1) > 0.01) return 0;
  const gap = Math.round(innerHeight - view.height - view.offsetTop);
  return gap > 2 ? gap : 0;
}

const editable = (element: Element | null) =>
  !!element &&
  (element.matches("input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]),textarea,select") ||
    (element as HTMLElement).isContentEditable);

export function watchViewportGap() {
  const view = window.visualViewport;
  if (!view) return () => {};
  const root = document.documentElement;
  let last = -1;
  let frame = 0;
  const update = () => {
    frame = 0;
    const gap = viewportGap(innerHeight, view, editable(document.activeElement));
    if (gap === last) return;
    last = gap;
    if (gap) root.style.setProperty("--vv-gap", gap + "px");
    else root.style.removeProperty("--vv-gap");
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(update);
  };
  // After the keyboard closes, nudge WebKit to recompute and measure again.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!editable(document.activeElement)) scrollTo(scrollX, scrollY);
      schedule();
    }, 300);
  };
  view.addEventListener("resize", schedule);
  view.addEventListener("scroll", schedule);
  addEventListener("resize", schedule);
  addEventListener("pageshow", schedule);
  document.addEventListener("focusin", schedule);
  document.addEventListener("focusout", settled);
  update();
  return () => {
    clearTimeout(timer);
    cancelAnimationFrame(frame);
    view.removeEventListener("resize", schedule);
    view.removeEventListener("scroll", schedule);
    removeEventListener("resize", schedule);
    removeEventListener("pageshow", schedule);
    document.removeEventListener("focusin", schedule);
    document.removeEventListener("focusout", settled);
  };
}
