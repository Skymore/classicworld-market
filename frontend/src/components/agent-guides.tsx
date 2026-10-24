import {useEffect, useState} from "react";
import {BookOpen, ArrowLeft} from "lucide-react";
import {Dialog, DialogContent, DialogTitle, DialogDescription} from "./ui/dialog";
import {evidenceUrl, sourceLabel} from "../lib/agent-sources";

type Guide = {id:string;title:string;summary:string;tags:string[];checked_on:string;checked_timezone:string;source_kind:string;needs_refresh:boolean;content?:string;sources:{title:string;url:string;kind:string;published_on?:string|null}[]};
export function AgentGuides({en}:{en:boolean}) {
  const [open,setOpen]=useState(false),[guides,setGuides]=useState<Guide[]>([]),[selected,setSelected]=useState<string|null>(null),[detail,setDetail]=useState<Guide|null>(null),[error,setError]=useState(false),[pending,setPending]=useState(false),[filter,setFilter]=useState("");
  useEffect(()=>{
    if(!open)return;
    const abort=new AbortController();setPending(true);setError(false);setDetail(null);
    fetch("/api/v1/agent/knowledge"+(selected?"/"+encodeURIComponent(selected):""),{signal:abort.signal,cache:"no-store"})
      .then(r=>{if(!r.ok)throw Error();return r.json();}).then(data=>{if(selected)setDetail(data);else setGuides(data.guides);})
      .catch(()=>{if(!abort.signal.aborted)setError(true);}).finally(()=>{if(!abort.signal.aborted)setPending(false);});
    return()=>abort.abort();
  },[open,selected]);
  const word=(zh:string,english:string)=>en?english:zh;
  return <>
    <button className="chat-guide-toggle" onClick={()=>{setSelected(null);setFilter("");setOpen(true);}} title={word("浏览内置指南","Browse built-in guides")} aria-label={word("浏览内置指南","Browse built-in guides")}><BookOpen size={16}/><span>{word("指南","Guides")}</span></button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="chat-guide-dialog">
        <DialogTitle>{detail?.title||word("内置冒险指南","Built-in adventure guides")}</DialogTitle>
        <DialogDescription>{word("经典世界国际服 · 中文整理 · 保留来源与核对日期","Global Classic World · Chinese notes with sources and review dates")}</DialogDescription>
        {selected?<button className="chat-guide-back" onClick={()=>setSelected(null)}><ArrowLeft size={15}/>{word("全部指南","All guides")}</button>:<input className="chat-guide-filter" aria-label={word("搜索内置指南","Search built-in guides")} placeholder={word("搜索转职、交易、公民、住房…","Search jobs, trading, citizenship, housing…")} value={filter} onChange={e=>setFilter(e.target.value)}/>}
        {pending?<p>{word("正在读取指南…","Loading guide…")}</p>:error?<p role="alert">{word("指南暂时无法读取，请稍后重试。","Could not load the guides. Please try again.")}</p>:detail?<article className="chat-guide-content">
          <p className="chat-guide-date">{word("核对日期：","Reviewed: ")}{detail.checked_on} · {detail.checked_timezone}</p>
          {detail.needs_refresh?<p className="chat-guide-refresh">{word("本主题需联网核对当前信息；旧文档不能代表最新状态。","This topic requires live verification; this note is not current confirmation.")}</p>:null}
          {detail.content?.replace(/^# [^\n]+\n*/,"").split(/\n\n+/).map((paragraph,i)=>paragraph.startsWith("- ")?<ul key={i}>{paragraph.split("\n").map((line,j)=><li key={j}>{line.replace(/^- /,"")}</li>)}</ul>:<p key={i}>{paragraph}</p>)}
          <p>{word("资料来源","Sources")}</p>
          {detail.sources.length?<ul>{detail.sources.filter(s=>evidenceUrl(s.url)).map(s=><li key={s.url}><a href={s.url} target="_blank" rel="noopener noreferrer">{s.title}</a><small> · {s.published_on||word("发布日期未记录","Publication date unknown")} · {sourceLabel(s.url,en)}</small></li>)}</ul>:<p>{word("本站方法说明；实际报价请让助手调用市场查询。","Site methodology; request current observed offers from the assistant.")}</p>}
        </article>:<div className="chat-guide-list">{guides.filter(g=>(g.title+g.tags.join(" ")).toLowerCase().includes(filter.trim().toLowerCase())).map(g=><button key={g.id} onClick={()=>setSelected(g.id)}><strong>{g.title}</strong><small>{g.summary}</small><span>{word("核对：","Reviewed: ")}{g.checked_on}{g.needs_refresh?word(" · 需查新"," · Live check required"):""}</span></button>)}</div>}
      </DialogContent>
    </Dialog>
  </>;
}
