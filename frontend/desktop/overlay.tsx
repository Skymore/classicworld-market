// The always-on-top grind overlay window (grind_desktop.GrindService). It polls
// window.pywebview.api.state(), never takes focus, is dragged to move and sized
// from its corner.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Volume2, VolumeX } from 'lucide-react';
import { createRoot } from 'react-dom/client';
import korean from '../../server/crates/market-web/src/i18n/ko.json';
import { installKorean, applyLanguage, tr } from './i18n';
import { overlayFit, overlayScale, overlayState, overlayToggle, type GroundDrop, type GrindSettings, type Live, type LootRow } from './grind';
import { OverlayCard, announceDrop } from './overlay-card';

document.documentElement.classList.add('overlay-page');
installKorean(korean);
applyLanguage('system');

function Overlay() {
  const [live, setLive] = useState<Live | null>(null), [settings, setSettings] = useState<GrindSettings | null>(null);
  const [toast, setToast] = useState<LootRow | null>(null), [dragged, setDragged] = useState<number | null>(null);
  const seen = useRef(0);
  const [drop, setDrop] = useState<GroundDrop | null>(null);
  const dropSeen = useRef<number | null>(null);
  useEffect(() => {
    let alive = true;
    const poll = () => overlayState().then(s => {
      if (!alive) return;
      setLive(s.live); setSettings(s.settings); applyLanguage(s.language || 'system');
      // A valuable item fell for this character or its party: show it for 8 s and announce it.
      const drops = (s.live?.characters || []).flatMap(c => c.drops || []);
      const newest = drops.reduce<GroundDrop | null>((best, d) => !best || d.t > best.t ? d : best, null);
      if (dropSeen.current === null) dropSeen.current = newest?.t ?? 0;
      else if (newest && newest.t > dropSeen.current) {
        dropSeen.current = newest.t;
        setDrop(newest);
        if (s.settings.buff_sound) announceDrop();
      }
      const notable = s.live?.runs?.[0]?.recent?.find(r => r.notable);
      if (notable && notable.t > seen.current) {
        if (seen.current) setToast(notable);
        seen.current = notable.t;
      }
    }).catch(() => null);
    poll();
    const id = setInterval(poll, 1000);
    window.addEventListener('pywebviewready', poll);
    return () => { alive = false; clearInterval(id); window.removeEventListener('pywebviewready', poll); };
  }, []);
  useEffect(() => { if (!toast) return; const id = setTimeout(() => setToast(null), 6000); return () => clearTimeout(id); }, [toast]);
  useEffect(() => { if (!drop) return; const id = setTimeout(() => setDrop(null), 8000); return () => clearTimeout(id); }, [drop]);
  // The window is exactly as tall as the card, so nothing invisible sits over the game.
  const watcher = useRef<ResizeObserver | null>(null);
  const card = useCallback((element: HTMLDivElement | null) => {
    watcher.current?.disconnect();
    if (!element) return;
    let last = 0;
    watcher.current = new ResizeObserver(() => {
      const height = Math.ceil(element.getBoundingClientRect().height);
      if (Math.abs(height - last) > 1) { last = height; overlayFit(height).catch(() => null); }
    });
    watcher.current.observe(element);
  }, []);
  if (!settings) return null;
  const scale = dragged ?? (settings.overlay.scale || 1);
  const toggle = (name: Switch) => {
    setSettings({ ...settings, [name]: !settings[name] });
    overlayToggle(name).then(value => setSettings(s => s && { ...s, [name]: value })).catch(() => null);
  };
  return <OverlayCard live={live} settings={settings} toast={toast} drop={drop} scale={scale} cardRef={card}
    grip={<><Switches settings={settings} toggle={toggle} /><Grip scale={scale} preview={setDragged} /></>} />;
}

type Switch = 'buff_sound';
/** Top-right on hover: auto buff, auto potions and the spoken warning, as in settings. */
function Switches({ settings, toggle }: { settings: GrindSettings; toggle(name: Switch): void }) {
  const button = (name: Switch, on: React.ReactNode, off: React.ReactNode, label: string) =>
    <button type="button" className={settings[name] ? 'on' : ''} aria-pressed={settings[name]} title={label} aria-label={label}
      onMouseDown={e => e.stopPropagation() /* not the window's drag-to-move */} onClick={() => toggle(name)}>{settings[name] ? on : off}</button>;
  return <div className="ov-switches">
    {button('buff_sound', <Volume2 size={12} />, <VolumeX size={12} />, tr('语音提醒（Buff、低血量）', 'Spoken warnings (buffs, low HP)'))}
  </div>;
}

/** Bottom-right corner: drag to size the overlay; the window follows through the bridge. */
function Grip({ scale, preview }: { scale: number; preview(scale: number | null): void }) {
  const drag = useRef<{ x: number; scale: number; width: number; next: number; busy: boolean } | null>(null);
  const send = () => {
    const d = drag.current;
    if (!d || d.busy) return;
    const sent = d.next; d.busy = true;
    overlayScale(sent).catch(() => null).finally(() => { d.busy = false; if (drag.current === d && d.next !== sent) send(); });
  };
  return <i className="ov-grip" aria-hidden="true"
    onMouseDown={e => e.stopPropagation() /* the window's drag-to-move must not start from this corner */}
    onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); drag.current = { x: e.screenX, scale, width: window.innerWidth, next: scale, busy: false }; }}
    onPointerMove={e => {
      const d = drag.current;
      if (!d) return;
      d.next = Math.round(Math.min(2, Math.max(.6, d.scale * (d.width + e.screenX - d.x) / d.width)) * 100) / 100;
      preview(d.next); send();
    }}
    onPointerUp={() => {
      const d = drag.current; drag.current = null;
      if (d) overlayScale(d.next).catch(() => null).finally(() => setTimeout(() => preview(null), 1200));
    }} />;
}

createRoot(document.getElementById('root')!).render(<Overlay />);
