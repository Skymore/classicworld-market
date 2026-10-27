import {useEffect,useState} from 'react';

export default function SitePage({page}:{page:'watch'|'prices'}) {
 const [url,setUrl]=useState(''),[error,setError]=useState('');
 const [attempt,retry]=useState(0);
 useEffect(()=>{let alive=true;setUrl('');setError('');
  window.pywebview!.api.workspace('page',{page,theme:document.documentElement.dataset.theme}).then((r:any)=>{if(alive)setUrl(r.url);}).catch((e:Error)=>{if(alive)setError(e.message||'页面暂时无法打开');});
  return()=>{alive=false;};
 },[page,attempt]);
 return error?<div className="error-banner">{error}<button onClick={()=>retry(attempt+1)}>重试</button></div>:url?
  <iframe className="desktop-site-page" title={page==='watch'?'关注整页':'价格表整页'} src={url} sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"/>:
  <p className="workspace-note">正在打开{page==='watch'?'关注':'价格表'}…</p>;
}
