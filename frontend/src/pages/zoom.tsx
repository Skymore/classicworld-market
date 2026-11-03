import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "react-router-dom";
import { useWords } from "../providers";

// A map picture that opens full screen. On phones a tap on the picture opens
// it (the markers are too small to hit inline); elsewhere the corner button
// does. Inside, the picture scrolls, and +/- or a two-finger pinch zoom it.

const PHONE = "(max-width: 700px)";
const MIN = 1,
  MAX = 6;
const clamp = (v: number) => Math.min(MAX, Math.max(MIN, v));

export function Zoomable({
  title,
  width,
  height,
  focus,
  children,
}: {
  title: string;
  /** The picture's own size (any unit); only the ratio matters. */
  width: number;
  height: number;
  /** A point (same units) to bring into view when opened. */
  focus?: { x: number; y: number } | null;
  /** The picture; `zoomed` is true for the full-screen copy. */
  children: (zoomed: boolean) => ReactNode;
}) {
  const words = useWords();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname, location.search]);
  const phone = () => window.matchMedia?.(PHONE).matches;
  return (
    <div className="zoomable">
      <div
        className="zoomable-pic"
        onClickCapture={(event) => {
          if (!phone()) return;
          event.preventDefault();
          event.stopPropagation();
          setOpen(true);
        }}
      >
        {children(false)}
      </div>
      <button
        type="button"
        className="zoom-open"
        aria-label={words("放大查看", "Enlarge")}
        title={words("放大查看", "Enlarge")}
        onClick={() => setOpen(true)}
      >
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" fill="none" stroke="currentColor" strokeWidth="2" />
        </svg>
      </button>
      {open &&
        createPortal(
          <ZoomDialog title={title} width={width} height={height} focus={focus} onClose={() => setOpen(false)}>
            {children(true)}
          </ZoomDialog>,
          document.body,
        )}
    </div>
  );
}

function ZoomDialog({
  title,
  width,
  height,
  focus,
  onClose,
  children,
}: {
  title: string;
  width: number;
  height: number;
  focus?: { x: number; y: number } | null;
  onClose: () => void;
  children: ReactNode;
}) {
  const words = useWords();
  const body = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: window.innerWidth, h: window.innerHeight - 52 });
  // Whole picture in view at zoom 1.
  const fit = Math.min(box.w / width, box.h / height);
  // Wide maps on a tall screen open at about two thirds of the height.
  const [zoom, setZoom] = useState(() => {
    const w = window.innerWidth,
      h = window.innerHeight - 52;
    const f = Math.min(w / width, h / height);
    return clamp((h * 0.66) / (height * f));
  });
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const scale = fit * zoom;
  // Zoom around a point of the viewport (px), keeping it in place.
  const zoomAt = (next: number, px: number, py: number) => {
    const el = body.current;
    if (!el) return setZoom(clamp(next));
    const old = zoomRef.current,
      z = clamp(next);
    const cx = (el.scrollLeft + px) / old,
      cy = (el.scrollTop + py) / old;
    setZoom(z);
    requestAnimationFrame(() => {
      el.scrollLeft = cx * z - px;
      el.scrollTop = cy * z - py;
    });
  };
  useEffect(() => {
    const resize = () => setBox({ w: window.innerWidth, h: window.innerHeight - 52 });
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("resize", resize);
    window.addEventListener("keydown", key);
    const root = document.documentElement;
    const overflow = [root.style.overflow, document.body.style.overflow];
    root.style.overflow = document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("resize", resize);
      window.removeEventListener("keydown", key);
      [root.style.overflow, document.body.style.overflow] = overflow;
    };
  }, [onClose]);
  // Bring the focus point (or the centre) into view once.
  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    const p = focus || { x: width / 2, y: height / 2 };
    el.scrollLeft = p.x * scale - el.clientWidth / 2;
    el.scrollTop = p.y * scale - el.clientHeight / 2;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Two-finger pinch.
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    let start: { d: number; z: number } | null = null;
    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const mid = (t: TouchList) => {
      const r = el.getBoundingClientRect();
      return [(t[0].clientX + t[1].clientX) / 2 - r.left, (t[0].clientY + t[1].clientY) / 2 - r.top];
    };
    const down = (e: TouchEvent) => {
      if (e.touches.length === 2) start = { d: dist(e.touches), z: zoomRef.current };
    };
    const move = (e: TouchEvent) => {
      if (!start || e.touches.length !== 2) return;
      e.preventDefault();
      const [px, py] = mid(e.touches);
      zoomAt((start.z * dist(e.touches)) / start.d, px, py);
    };
    const up = (e: TouchEvent) => {
      if (e.touches.length < 2) start = null;
    };
    el.addEventListener("touchstart", down, { passive: true });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", up);
    return () => {
      el.removeEventListener("touchstart", down);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const step = (factor: number) => {
    const el = body.current;
    zoomAt(zoomRef.current * factor, (el?.clientWidth || 0) / 2, (el?.clientHeight || 0) / 2);
  };
  return (
    <div className="zoom-dialog" role="dialog" aria-modal="true" aria-label={title}>
      <div className="zoom-bar">
        <b>{title}</b>
        <button type="button" onClick={() => step(1 / 1.5)} disabled={zoom <= MIN} aria-label={words("缩小", "Zoom out")}>
          −
        </button>
        <span className="zoom-pct">{Math.round(zoom * 100)}%</span>
        <button type="button" onClick={() => step(1.5)} disabled={zoom >= MAX} aria-label={words("放大", "Zoom in")}>
          +
        </button>
        <button type="button" className="zoom-close" onClick={onClose} aria-label={words("关闭", "Close")}>
          ×
        </button>
      </div>
      <div className="zoom-body" ref={body}>
        <div className="zoom-stage" style={{ width: width * scale, height: height * scale }}>
          {children}
        </div>
      </div>
    </div>
  );
}
