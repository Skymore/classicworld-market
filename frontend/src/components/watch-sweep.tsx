import { useEffect, useMemo, useRef, useState } from 'react';
import { useUserValue } from '../lib/live';
import { useWords } from '../providers';
import { flush, getSyncState } from '/web/js/lib/user-data.js';
import { watchGroups } from '/web/js/lib/watch-reminders.js?v=20261027-watch-groups-1';

const defaults={budget:1000000,maxOrder:400000,wallet:1500000,reserve:200000,slots:24,reserveSlots:4};
export default function WatchSweep({ids,settings,items,reference,personal}:any){
  const words=useWords(),[raw,write]=useUserValue('watch.sweepSettings',JSON.stringify(defaults));
  const limits=useMemo(()=>{try{return {...defaults,...JSON.parse(raw)};}catch{return defaults;}},[raw]);
  const [open,setOpen]=useState(false),[state,setState]=useState<any>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[key,setKey]=useState('');
  const csrf=useRef(''), latest=useRef(''), revision=useRef(0);
  const watches=ids.map((id:number)=>({item_id:id,name:items.get(id)?.name_zh||items.get(id)?.name_en||String(id),limit:settings[id]?.buyLimit??1,
    base_stats:reference.baseStats?.[id]||[],groups:watchGroups(settings[id]).filter((g:any)=>g.buy)})).filter((w:any)=>w.groups.length);
  const signature=JSON.stringify({mode:'simulate',limits,watches});latest.current=signature;
  useEffect(()=>{let alive=true;setKey('');crypto.subtle.digest('SHA-256',new TextEncoder().encode(signature)).then(b=>{if(alive)setKey([...new Uint8Array(b)].map(n=>n.toString(16).padStart(2,'0')).join(''));});return()=>{alive=false;};},[signature]);
  const base=personal?.base, connected=base!==undefined;
  useEffect(()=>{
    if(!connected){setState(null);return;}
    let alive=true;const abort=new AbortController();
    async function poll(){try{const r=await fetch(base+'/api/v1/collector/sweep',{cache:'no-store',signal:AbortSignal.any([abort.signal,AbortSignal.timeout(4000)])});if(!r.ok)throw Error('unavailable');const s=await r.json();if(alive){csrf.current=s.csrf;setState(s);}}catch{if(alive){csrf.current='';setState(null);}}}
    poll();const timer=setInterval(poll,3000);return()=>{alive=false;abort.abort();clearInterval(timer);};
  },[base,connected]);
  async function send(action:string,quiet=false){
    if(!csrf.current)return;
    const sent=signature, rev=++revision.current;
    if(!quiet)setBusy(true);setError('');
    try{
      if(action==='start') {
        await flush();
        const sync=getSyncState();
        if(sync.signed_in&&(sync.pending||sync.status!=='synced'))throw Error(words('请等待关注同步完成后再开始','Wait for watchlist sync before starting'));
        if(latest.current!==sent)throw Error(words('条件已变化，请重新开始','Conditions changed; please start again'));
      }
      const r=await fetch(base+'/api/v1/collector/sweep',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf.current},body:JSON.stringify({action,...JSON.parse(sent),source_key:key}),signal:AbortSignal.timeout(8000)});
      const s=await r.json();if(!r.ok)throw Error(s.error||'操作失败');
      if(rev===revision.current)setState(s);
    }catch(e){setError(e instanceof Error?e.message:String(e));}finally{if(!quiet)setBusy(false);}
  }
  useEffect(()=>{if(key&&state?.enabled&&state.source_key!==key&&!busy)send('stop',true);},[key,state?.enabled,state?.source_key,busy]);
  const count=watches.reduce((n:number,w:any)=>n+w.groups.length,0);
  const status=!state?words('打开新版扫描器后可模拟','Open the updated scanner to simulate'):state.enabled?words('模拟运行中','Simulation running'):words('模拟已停止','Simulation stopped');
  return <div className="watch-sweep">
    <div className="sweep-toolbar"><div><b>{words('扫货内测 · 仅模拟','Sweep beta · Simulation only')}</b><div className="sweep-note">{count} {words('组已选','groups selected')} · {status}{state?.checked?` · ${words('已检查','Checked')} ${state.checked} ${words('家','shops')}`:''}</div></div>
      <div className="actions"><button className="btn" onClick={()=>setOpen(!open)} aria-expanded={open}>{words('扫货设置','Sweep settings')}</button><button className="btn primary" disabled={!state||busy||!key||(!count&&!state.enabled)} onClick={()=>send(state.enabled?'stop':'start')}>{state?.enabled?words('停止模拟','Stop simulation'):words('开始新一轮模拟','Start new simulation')}</button></div></div>
    {open&&<div className="sweep-settings"><div className="sweep-settings-grid">{([
      ['budget','本轮预算','Session budget'],['maxOrder','单次交易上限','Per-transaction cap'],['wallet','模拟钱包余额','Simulated wallet'],['reserve','至少保留金币','Reserve mesos'],['slots','各类背包模拟空格','Simulated slots per inventory'],['reserveSlots','各类背包至少留空格','Reserve slots per inventory']
    ] as const).map(([field,zh,en])=><label key={field}>{words(zh,en)}<input type="number" min={0} max={field.toLowerCase().includes('slots')?96:1000000000000} step={1} value={limits[field]} onChange={e=>{const n=Number(e.target.value);if(Number.isSafeInteger(n)&&n>=0)write(JSON.stringify({...limits,[field]:n}));}}/></label>)}</div><p className="sweep-note">{words('只处理开始后的新采集。修改条件会停止本轮；下次开始重置模拟预算与数量。','Only new captures are processed. Editing conditions stops the session; starting again resets simulated limits.')}</p></div>}
    {error&&<p className="sweep-error" role="alert">{error}</p>}
    {state?.session_id&&<div className="sweep-results"><p className="sweep-note">{words('本轮模拟','This simulation')} · {state.units} {words('件','units')} · {Number(state.spent).toLocaleString()} {words('金币','mesos')}{state.message?` · ${state.message}`:''}</p>
      {(state.recent||[]).slice(0,5).map((r:any)=><div className="sweep-result" key={r.key}><span>{r.name} × {r.units||0} <small>FM {r.room} · CH {r.channel}</small></span><span>{r.reason||words('模拟买入','Simulated purchase')}{r.cost?` · ${r.cost.toLocaleString()}`:''}</span></div>)}</div>}
  </div>;
}
