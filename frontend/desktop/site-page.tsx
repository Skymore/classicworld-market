import { useEffect, useRef, useState } from 'react';

export interface WatchSummary { hits: number; watches: number; synced: boolean }

/** A whole website page in embed mode (desktop_workspace.py adds embed=1); reloads when the theme changes.
 * The watch page stays mounted while hidden so its hit badge keeps updating. */
export default function SitePage({ page, theme, hidden = false, onSummary }: {
  page: 'watch' | 'prices'; theme: 'light' | 'dark'; hidden?: boolean; onSummary?(summary: WatchSummary): void;
}) {
  const [url, setUrl] = useState(''), [error, setError] = useState('');
  const [attempt, retry] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    let alive = true; setUrl(''); setError('');
    window.pywebview!.api.workspace('page', { page, theme }).then((r: any) => { if (alive) setUrl(r.url); })
      .catch((e: Error) => { if (alive) setError(e.message || '页面暂时无法打开'); });
    return () => { alive = false; };
  }, [page, theme, attempt]);
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
  return error ? <div className="error-banner" style={style}>{error}<button onClick={() => retry(attempt + 1)}>重试</button></div> : url ?
    <iframe ref={frame} className="desktop-site-page" style={style} title={page === 'watch' ? '关注整页' : '价格表整页'} src={url}
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads" /> :
    hidden ? null : <p className="workspace-note">正在打开{page === 'watch' ? '关注' : '价格表'}…</p>;
}
