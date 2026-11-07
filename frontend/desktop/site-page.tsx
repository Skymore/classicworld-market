import { useEffect, useRef, useState } from 'react';
import { tr, type Lang } from './i18n';

export interface WatchSummary { hits: number; watches: number; synced: boolean }
/** Website sections shown as tabs (desktop_workspace.SITE_PAGES). */
export type SitePageKey = 'home' | 'dex' | 'watch' | 'tools';
export const SITE_LABELS: Record<SitePageKey, [string, string]> = {
  home: ['价格表', 'Prices'], dex: ['图鉴', 'Catalogue'], watch: ['关注', 'Watch'], tools: ['工具', 'Tools'],
};

/** A whole website page in embed mode (desktop_workspace.py adds embed=1); reloads when the theme or
 * language changes. The watch page comes from the collector's loopback gateway (it signs in through
 * it); the other sections come from the website itself, so they always match it.
 * The watch page stays mounted while hidden so its hit badge keeps updating. */
export default function SitePage({ page, theme, lang, hidden = false, onSummary }: {
  page: SitePageKey; theme: 'light' | 'dark'; lang: Lang; hidden?: boolean; onSummary?(summary: WatchSummary): void;
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
  const style = hidden ? { display: 'none' } : undefined;
  const label = tr(...SITE_LABELS[page]);
  return error ? <div className="error-banner" style={style}>{error}<button onClick={() => retry(attempt + 1)}>{tr('重试', 'Retry')}</button></div> : url ?
    <iframe ref={frame} className="desktop-site-page" style={style} title={label} src={url}
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads" /> :
    hidden ? null : <p className="workspace-note">{tr(`正在打开${label}…`, `Opening ${label}…`)}</p>;
}
