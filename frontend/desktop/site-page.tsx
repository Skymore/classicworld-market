import { useEffect, useRef, useState } from 'react';
import { tr, type Lang } from './i18n';

export interface WatchSummary { hits: number; watches: number; synced: boolean }
/** Website sections shown as tabs (desktop_workspace.SITE_PAGES). */
export type SitePageKey = 'home' | 'dex' | 'watch' | 'selling' | 'tools' | 'sweep' | 'account';
export const SITE_LABELS: Record<SitePageKey, [string, string]> = {
  home: ['首页', 'Home'], dex: ['图鉴', 'Catalogue'], watch: ['关注', 'Watch'], selling: ['摆摊', 'Shop'], tools: ['工具', 'Tools'],
  sweep: ['扫货', 'Sweep'], account: ['账号', 'Account'],
};
/** What this window tells the sweep and account pages about itself (frontend/src/client/host.ts). */
export interface HostShell {
  version: string; updates: string; uploaded: number; gameLive: boolean; gameLabel: string;
  watch: { watches: number; synced: boolean } | null;
}
/** The `workspace(action)` calls each collector page may make. Nothing else is forwarded:
 * a page cannot reach the scanner, the updater or the window controls. */
const PAGE_ACTIONS: Partial<Record<SitePageKey, string[]>> = {
  sweep: ['status', 'devices', 'start', 'stop', 'login'],
  account: ['status', 'devices', 'rename', 'login', 'logout'],
};

/** A whole website page in embed mode (desktop_workspace.py adds embed=1); reloads when the theme or
 * language changes. The watch page comes from the collector's loopback gateway (it signs in through
 * it); the other sections come from the website itself, so they always match it.
 * The watch page stays mounted while hidden so its hit badge keeps updating. */
export default function SitePage({ page, theme, lang, hidden = false, onSummary, shell, onShell }: {
  page: SitePageKey; theme: 'light' | 'dark'; lang: Lang; hidden?: boolean; onSummary?(summary: WatchSummary): void;
  /** For the sweep and account pages: this window's state, and its own actions ("watch", "website"). */
  shell?: HostShell; onShell?(action: 'watch' | 'website'): void;
}) {
  const [url, setUrl] = useState(''), [error, setError] = useState('');
  const [attempt, retry] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    let alive = true; setUrl(''); setError('');
    window.pywebview!.api.workspace('page', { page, theme, lang }).then((r: any) => { if (alive) setUrl(r.url); })
      .catch((e: Error) => { if (alive) setError(e.message || tr('页面暂时无法打开', 'The page cannot open right now')); });
    return () => { alive = false; };
  }, [page, theme, lang, attempt]);
  useEffect(() => {
    if (!onSummary || !url) return;
    const origin = new URL(url).origin;
    // Only this frame's own loopback page may report; the values are counts and a flag.
    const receive = (event: MessageEvent) => {
      const data = event.data;
      if (event.source !== frame.current?.contentWindow || event.origin !== origin || data?.type !== 'cwm-watch') return;
      const count = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0 ? n as number : 0;
      onSummary({ hits: count(data.hits), watches: count(data.watches), synced: data.synced === true });
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [url, onSummary]);
  // The stall planner is the website's page; this window hands it the PC's bag. The message goes
  // only to the page's own origin and carries the bag alone.
  useEffect(() => {
    if (page !== 'selling' || !url || hidden) return;
    const origin = new URL(url).origin;
    let alive = true;
    const send = () => window.pywebview!.api.workspace('inventory').then((r: any) => {
      if (alive) frame.current?.contentWindow?.postMessage({ type: 'cwm-bag', holdings: r?.holdings ?? null }, origin);
    }).catch(() => {});
    const asked = (event: MessageEvent) => {
      if (event.source === frame.current?.contentWindow && event.origin === origin && event.data?.type === 'cwm-bag-request') send();
    };
    window.addEventListener('message', asked);
    const timer = window.setInterval(send, 3000);
    send();
    return () => { alive = false; clearInterval(timer); window.removeEventListener('message', asked); };
  }, [page, url, hidden]);
  // The sweep and account pages are built with the website but act through this window: they
  // send `cwm-rpc` requests and get `cwm-rpc-result` answers. Only this frame's own loopback
  // page is heard, and only the actions listed for it are run.
  const actions = PAGE_ACTIONS[page];
  const shellText = JSON.stringify(shell ?? null);
  const onShellRef = useRef(onShell);
  onShellRef.current = onShell;
  useEffect(() => {
    if (!actions || !url) return;
    const target = new URL(url);
    if (!['127.0.0.1', 'localhost'].includes(target.hostname)) return;
    const origin = target.origin;
    const post = (message: unknown) => frame.current?.contentWindow?.postMessage(message, origin);
    const sendShell = () => post({ type: 'cwm-shell', shell: JSON.parse(shellText) });
    const receive = (event: MessageEvent) => {
      const data = event.data;
      if (event.source !== frame.current?.contentWindow || event.origin !== origin || !data) return;
      if (data.type === 'cwm-shell-request') return sendShell();
      if (data.type !== 'cwm-rpc' || typeof data.id !== 'number' || typeof data.action !== 'string') return;
      const answer = (ok: boolean, value?: unknown, error?: string) => post({ type: 'cwm-rpc-result', id: data.id, ok, value, error });
      if (data.action === 'shell:watch' || data.action === 'shell:website') {
        onShellRef.current?.(data.action === 'shell:watch' ? 'watch' : 'website');
        return answer(true, null);
      }
      if (!actions.includes(data.action)) return answer(false, undefined, 'invalid_request');
      window.pywebview!.api.workspace(data.action, data.value)
        .then((value: unknown) => answer(true, value))
        .catch((e: unknown) => answer(false, undefined, String((e as Error)?.message || e)));
    };
    window.addEventListener('message', receive);
    sendShell();
    return () => window.removeEventListener('message', receive);
  }, [actions, url, shellText]);
  const style = hidden ? { display: 'none' } : undefined;
  const label = tr(...SITE_LABELS[page]);
  return error ? <div className="error-banner" style={style}>{error}<button onClick={() => retry(attempt + 1)}>{tr('重试', 'Retry')}</button></div> : url ?
    <iframe ref={frame} className="desktop-site-page" style={style} title={label} src={url}
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads" /> :
    hidden ? null : <p className="workspace-note">{tr(`正在打开${label}…`, `Opening ${label}…`)}</p>;
}
