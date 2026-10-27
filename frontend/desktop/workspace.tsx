import {useEffect,useRef,useState} from 'react';

const defaults={budget:1000000,maxOrder:400000,wallet:1500000,reserve:200000,slots:24,reserveSlots:4};
const groups=(v:any)=>Array.isArray(v?.groups)?v.groups:[{id:'default',name:'',cap:v?.cap??null,notify:v?.notify!==false,buy:false,reminder:v?.reminder||{}}];
const invoke=(name:string,value?:any)=>window.pywebview!.api.workspace(name,value);
export default function Workspace({tab}:{tab:'sweep'|'account'}){
 const [data,setData]=useState<any>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
 const [limits,setLimits]=useState(defaults),[limitsDirty,setLimitsDirty]=useState(false);
 const account=useRef<string|undefined>(undefined);
 const records=data?.records||[],simulation=data?.simulation;
 function accept(next:any){
  if(account.current!==next.public_id){setLimitsDirty(false);account.current=next.public_id;}
  setData(next);
 }
 useEffect(()=>{let alive=true;let running=false;async function poll(){if(running)return;running=true;try{const next=await invoke('status');if(alive){accept(next);setError('');}}catch(e){if(alive)setError(String((e as Error).message||e));}finally{running=false;}}
  poll();const timer=setInterval(poll,5000);return()=>{alive=false;clearInterval(timer);};},[]);
 const savedLimits=records.find((r:any)=>r.kind==='pref'&&r.key==='watch.sweepSettings');
 useEffect(()=>{if(!limitsDirty){try{setLimits({...defaults,...JSON.parse(savedLimits?.value||'{}')});}catch{}}},[JSON.stringify(savedLimits),limitsDirty]);
 const watches=records.filter((r:any)=>r.kind==='watch'&&r.value).sort((a:any,b:any)=>(a.value.position||0)-(b.value.position||0));
 const run=async(action:string,value?:any)=>{if(busy)return;setBusy(true);setError('');setNotice('');try{const next=await invoke(action,value);if(next.records)accept(next);return next;}catch(e){setError(String((e as Error).message||e));return null;}finally{setBusy(false);}};
 const save=async(operations:any[])=>run('save',{account:data.public_id,operations});
 const number=(title:string,value:any,update:(v:any)=>void,max=1e12,min=0)=><label>{title}<input type="number" min={min} max={max} step={1} value={value??''} onChange={e=>{const n=e.target.value===''?null:Number(e.target.value);if(n===null||Number.isSafeInteger(n)&&n>=min&&n<=max)update(n);}}/></label>;
 const count=watches.reduce((n:number,r:any)=>n+groups(r.value).filter((g:any)=>g.buy).length,0);
 return <section className="native-workspace stall"><div className="stall-bar"><h2>{tab==='account'?'我的账号':'扫货模拟'}</h2><span className="bar-meta">{data?.linked?`${data.nickname} · 已同步`:'未登录'}</span></div>
 <div className={"workspace-scroll"+(tab==='sweep'&&data?.linked?' sweep-workspace':'')}>
 {error&&<p className="error-banner" role="alert">{error}</p>}{notice&&<p role="status" className="workspace-notice">{notice}</p>}
 {tab==='account'?<div className="native-account"><h2>{data?.linked?data.nickname:'登录枫叶市集'}</h2><p>登录网站同一账号，关注条件会在电脑与网页间同步。</p>{data?.linked?<><span>当前扫描器已登录</span><button className="ui-btn" disabled={busy} onClick={()=>run('logout',{account:data.public_id})}>退出本机账号</button></>:<button className="ui-btn primary" disabled={busy} onClick={async()=>{if(await run('login'))setNotice('请在浏览器完成登录并关联此扫描器，完成后这里会自动更新。');}}>登录 / 注册</button>}</div>:
 !data?.linked?<div className="native-account"><h2>登录后同步关注</h2><p>使用网站的账号，已有关注会自动出现在这里。</p><button className="ui-btn primary" disabled={busy} onClick={async()=>{if(await run('login'))setNotice('请在浏览器完成登录并关联此扫描器。');}}>登录 / 注册</button></div>:<>
 <div className="native-sweep-bar"><div><b>扫货内测 · 仅模拟</b><p>{count} 组已选 · {simulation?.enabled?'模拟运行中':'模拟已停止'} · {simulation?.units||0} 件 · {(simulation?.spent||0).toLocaleString()} 金币</p></div><button className="ui-btn primary" disabled={busy||!simulation||(!simulation.enabled&&(limitsDirty||!count))} onClick={async()=>{
  if(simulation.enabled){await run('stop');return;}if(!savedLimits){const next=await save([{kind:'pref',key:'watch.sweepSettings',value:JSON.stringify(limits),version:0}]);if(!next)return;}await run('start',{account:data.public_id});
 }}>{simulation?.enabled?'停止模拟':'开始模拟'}</button></div>
 {simulation?.message&&<p className="workspace-note">{simulation.message}</p>}
 <details className="native-budget"><summary>预算与背包</summary><div className="native-fields">{([['budget','本轮预算'],['maxOrder','单笔上限'],['wallet','模拟钱包余额'],['reserve','保留金币'],['slots','每类背包模拟空格'],['reserveSlots','每类背包保留格']] as const).map(([k,label])=><div key={k}>{number(label,limits[k],v=>{setLimits({...limits,[k]:v??0});setLimitsDirty(true);},k.toLowerCase().includes('slots')?96:1e12)}</div>)}</div><button className="ui-btn" disabled={busy||(!limitsDirty&&!!savedLimits)} onClick={async()=>{if(await save([{kind:'pref',key:'watch.sweepSettings',version:savedLimits?.version||0,value:JSON.stringify(limits)}])){setLimitsDirty(false);setNotice('预算已保存');}}}>保存预算</button></details>
 <details className="native-history"><summary>本轮模拟记录 · {simulation?.checked||0} 家已检查</summary>{(simulation?.recent||[]).map((r:any)=><div key={r.key} className="native-history-row"><span>{r.name} × {r.units||0}<small>FM {r.room} · CH {r.channel}</small></span><span>{r.reason||'模拟买入'} · {(r.cost||0).toLocaleString()}</span></div>)}</details>
 </>}
 </div></section>;
}
