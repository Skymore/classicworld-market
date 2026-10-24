import {useEffect, useState} from "react";
import {BookOpen, ArrowLeft} from "lucide-react";
import {Dialog, DialogContent, DialogTitle, DialogDescription} from "./ui/dialog";
import {evidenceUrl, sourceLabel} from "../lib/agent-sources";

type Guide = {id:string;title:string;summary:string;tags:string[];subjects?:string[];category?:string;related_guides?:string[];evidence_note?:string;checked_on:string;checked_timezone:string;source_kind:string;needs_refresh:boolean;content?:string;sources:{title:string;url:string;kind:string;published_on?:string|null}[]};

// Authored notes use only headings, lists and allowlisted links. React renders
// everything else as text; neither source HTML nor model HTML is executed.
function inline(text:string) {
  return text.split(/(\[[^\]\n]+\]\([^\s)]+\))/g).map((part,i)=>{
    const link=/^\[([^\]]+)\]\(([^\s)]+)\)$/.exec(part);
    return link&&evidenceUrl(link[2])?<a key={i} href={link[2]} target="_blank" rel="noopener noreferrer">{link[1]}</a>:part;
  });
}
function GuideText({content}:{content:string}) {
  return <>{content.replace(/^# [^\n]+\n*/,"").split(/\n\n+/).map((block,i)=>{
    if(block.startsWith("## "))return <h3 key={i}>{inline(block.slice(3))}</h3>;
    const lines=block.split("\n");
    if(lines.every(line=>line.startsWith("- ")))return <ul key={i}>{lines.map((line,j)=><li key={j}>{inline(line.slice(2))}</li>)}</ul>;
    if(lines.every(line=>/^\d+\. /.test(line)))return <ol key={i}>{lines.map((line,j)=><li key={j}>{inline(line.replace(/^\d+\. /,""))}</li>)}</ol>;
    return <p key={i}>{inline(block)}</p>;
  })}</>;
}
export function AgentGuides({en}:{en:boolean}) {
  const [open,setOpen]=useState(false),[guides,setGuides]=useState<Guide[]>([]),[selected,setSelected]=useState<string|null>(null),[detail,setDetail]=useState<Guide|null>(null),[error,setError]=useState(false),[pending,setPending]=useState(false),[filter,setFilter]=useState("");
  const [category,setCategory]=useState("all");
  useEffect(()=>{
    if(!open)return;
    const abort=new AbortController();setPending(true);setError(false);setDetail(null);
    fetch("/api/v1/agent/knowledge"+(selected?"/"+encodeURIComponent(selected):""),{signal:abort.signal,cache:"no-store"})
      .then(r=>{if(!r.ok)throw Error();return r.json();}).then(data=>{if(selected)setDetail(data);else setGuides(data.guides);})
      .catch(()=>{if(!abort.signal.aborted)setError(true);}).finally(()=>{if(!abort.signal.aborted)setPending(false);});
    return()=>abort.abort();
  },[open,selected]);
  const word=(zh:string,english:string)=>en?english:zh;
  const visible=guides.filter(g=>(category==="all"||g.category===category)&&(g.title+g.tags.join(" ")+g.summary).toLowerCase().includes(filter.trim().toLowerCase()));
  return <>
    <button className="chat-guide-toggle" onClick={()=>{setSelected(null);setFilter("");setCategory("all");setOpen(true);}} title={word("浏览内置指南","Browse built-in guides")} aria-label={word("浏览内置指南","Browse built-in guides")}><BookOpen size={16}/><span>{word("指南","Guides")}</span></button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="chat-guide-dialog">
        <DialogTitle className="chat-guide-title">{detail?.title||word("内置冒险指南","Built-in adventure guides")}</DialogTitle>
        <DialogDescription className="chat-guide-caption">{word("经典世界国际服 · 中文整理 · 保留来源与核对日期","Global Classic World · Chinese notes with sources and review dates")}</DialogDescription>
        {selected?<button className="chat-guide-back" onClick={()=>setSelected(null)}><ArrowLeft size={15}/>{word("全部指南","All guides")}</button>:<>
          <input className="chat-guide-filter" aria-label={word("搜索内置指南","Search built-in guides")} placeholder={word("搜索职业、加点、练级、任务…","Search classes, builds, training, quests…")} value={filter} onChange={e=>setFilter(e.target.value)}/>
          <div className="chat-guide-categories" aria-label={word("指南分类","Guide categories")}>{[["all","全部","All"],["builds","职业加点","Class builds"],["training","升级路线","Training"],["basics","常见问题","FAQ"]].map(([id,zh,english])=><button key={id} aria-pressed={category===id} onClick={()=>setCategory(id)}>{word(zh,english)}</button>)}</div>
        </>}
        {pending?<p>{word("正在读取指南…","Loading guide…")}</p>:error?<p role="alert">{word("指南暂时无法读取，请稍后重试。","Could not load the guides. Please try again.")}</p>:detail?<article className="chat-guide-content">
          <p className="chat-guide-date">{word("核对日期：","Reviewed: ")}{detail.checked_on} · {detail.checked_timezone}</p>
          {detail.needs_refresh?<p className="chat-guide-refresh">{word("本主题需联网核对当前信息；旧文档不能代表最新状态。","This topic requires live verification; this note is not current confirmation.")}</p>:null}
          <GuideText content={detail.content||""}/>
          {!!detail.related_guides?.length&&<nav className="chat-guide-related" aria-label={word("相关指南","Related guides")}>{detail.related_guides.map(id=>{const guide=guides.find(g=>g.id===id);return guide?<button key={id} onClick={()=>setSelected(id)}>{guide.title}</button>:null;})}</nav>}
          <h3>{word("资料来源","Sources")}</h3>
          {detail.sources.length?<ul>{detail.sources.filter(s=>evidenceUrl(s.url)).map(s=><li key={s.url}><a href={s.url} target="_blank" rel="noopener noreferrer">{s.title}</a><small> · {s.published_on||word("发布日期未记录","Publication date unknown")} · {sourceLabel(s.url,en)}</small></li>)}</ul>:<p>{word("本站方法说明；实际报价请让助手调用市场查询。","Site methodology; request current observed offers from the assistant.")}</p>}
        </article>:<div className="chat-guide-list">{!visible.length?<p>{word("没有匹配的指南，试试职业名称或清空筛选。","No matching guides. Try a class name or clear the filters.")}</p>:visible.map(g=><button key={g.id} onClick={()=>setSelected(g.id)}><strong>{g.title}</strong><small>{g.summary}</small><span>{word("核对：","Reviewed: ")}{g.checked_on}{g.needs_refresh?word(" · 需查新"," · Live check required"):""}</span></button>)}</div>}
      </DialogContent>
    </Dialog>
  </>;
}
