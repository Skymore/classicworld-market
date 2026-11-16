// The always-on-top grind overlay window (grind_desktop.GrindService). It polls
// window.pywebview.api.state(), never takes focus, is dragged to move; its size is set in settings
// from its corner.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Volume2, VolumeX } from 'lucide-react';
import { createRoot } from 'react-dom/client';
import korean from '../../server/crates/market-web/src/i18n/ko.json';
import { installKorean, applyLanguage, tr } from './i18n';
import { overlayCommand, overlayFit, overlayRegions, overlayState, overlayToggle, overlayUpdate, type ClientUpdate, type GroundDrop, type GrindSettings, type Live, type LootRow } from './grind';
import { OverlayCard, announceDrop } from './overlay-card';

document.documentElement.classList.add('overlay-page');
// The client reads the overlay's clicks from the system mouse (the game in front can keep
// them from the page) and presses the button here; it needs to know where each one is.
(window as unknown as { __overlayPress?(id: string): void }).__overlayPress = id =>
  (document.querySelector(`[data-press="${id}"]`) as HTMLElement | null)?.click();
let reported = '';
function reportRegions() {
  const regions = [...document.querySelectorAll<HTMLElement>('[data-press]')].map(el => {
    const r = el.getBoundingClientRect();
    return { id: el.dataset.press, x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  }).filter(r => r.w > 0 && r.h > 0);
  const text = JSON.stringify(regions);
  if (text !== reported) { reported = text; overlayRegions(regions).catch(() => { reported = ''; }); }
}
setInterval(reportRegions, 500);
installKorean(korean);
applyLanguage('system');

function Overlay() {
  const [live, setLive] = useState<Live | null>(null), [settings, setSettings] = useState<GrindSettings | null>(null);
  const [toast, setToast] = useState<LootRow | null>(null);
  const seen = useRef(0);
  const [drop, setDrop] = useState<GroundDrop | null>(null);
  const dropSeen = useRef<number | null>(null);
  const dropsNow = useRef<GroundDrop[]>([]);
  const [update, setUpdate] = useState<ClientUpdate | null>(null);
  useEffect(() => {
    let alive = true;
    const poll = () => overlayState().then(s => {
      if (!alive) return;
      setLive(s.live); setSettings(s.settings); applyLanguage(s.language || 'system'); setUpdate(s.update ?? null);
      // A valuable item fell for this character or its party: show it for 8 s and announce it.
      const drops = (s.live?.characters || []).flatMap(c => c.drops || []);
      dropsNow.current = drops;
      const newest = drops.reduce<GroundDrop | null>((best, d) => !best || d.t > best.t ? d : best, null);
      if (dropSeen.current === null) dropSeen.current = newest?.t ?? 0;
      else if (newest && newest.t > dropSeen.current) {
        dropSeen.current = newest.t;
        setDrop(newest);
        // Named by its clip; an item outside the voice pack by whatever name has arrived by then.
        if (s.settings.buff_sound) announceDrop(newest.item_id, () => dropsNow.current.find(d => d.object === newest.object && d.t === newest.t)?.name);
      } else setDrop(cur => cur && (drops.find(d => d.object === cur.object && d.t === cur.t) || cur)); // name and price arrive a moment later
      // Picked up something worth showing (equipment, scrolls, stars, bullets, or notable value): name and price.
      const notable = s.live?.runs?.[0]?.recent?.find(r => r.alert || r.notable);
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
  const dropKey = drop ? `${drop.object}@${drop.t}` : null;
  useEffect(() => { if (!dropKey) return; const id = setTimeout(() => setDrop(null), 8000); return () => clearTimeout(id); }, [dropKey]);
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
  const scale = settings.overlay.scale || 1;
  const toggle = (name: Switch) => {
    setSettings({ ...settings, [name]: !settings[name] });
    overlayToggle(name).then(value => setSettings(s => s && { ...s, [name]: value })).catch(() => null);
  };
  return <OverlayCard live={live} settings={settings} toast={toast} drop={drop} scale={scale} cardRef={card} command={action => { overlayCommand(action).catch(() => null); }}
    update={update} onUpdate={() => { setUpdate(u => u && { ...u, state: 'requested' }); overlayUpdate().catch(() => null); }}
    grip={<Switches settings={settings} toggle={toggle} />} />;
}

type Switch = 'buff_sound';
/** Top-right on hover: auto buff, auto potions and the spoken warning, as in settings. */
function Switches({ settings, toggle }: { settings: GrindSettings; toggle(name: Switch): void }) {
  const button = (name: Switch, on: React.ReactNode, off: React.ReactNode, label: string) =>
    <button type="button" className={settings[name] ? 'on' : ''} aria-pressed={settings[name]} title={label} aria-label={label}
      data-press={name} onMouseDown={e => e.stopPropagation() /* not the window's drag-to-move */} onClick={() => toggle(name)}>{settings[name] ? on : off}</button>;
  return <div className="ov-switches">
    {button('buff_sound', <Volume2 size={12} />, <VolumeX size={12} />, tr('语音提醒（Buff、低血量）', 'Spoken warnings (buffs, low HP)'))}
  </div>;
}

createRoot(document.getElementById('root')!).render(<Overlay />);
