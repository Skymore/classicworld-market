import { Fragment, useEffect, useRef, useState } from 'react';
import { useWords } from '../providers';
import WatchReminder from './watch-reminder';
import { watchGroups, reminderSelection, reminderTokens } from '/web/js/lib/watch-reminders.js?v=20261106-server-caps';
import './watch-groups.css';

// No price, no other condition and no alert: the item is only watched for its prices.
export const trackOnly=(g:any)=>!g.notify&&!g.buy&&g.cap===null&&g.reminder.percentile==='all'&&!reminderTokens(g.reminder).length;
// Percentiles are resolved by the server when the run starts.
export const sweepable=(g:any)=>(g.reminder.percentile!=='all'||(g.cap!==null&&g.cap>0))&&g.reminder.equipment!=='missing';

export default function WatchGroups({id,name,setting,rows,reference,onChange,sweep=false,autoEdit=false}: {
  id:number; name:string; setting:any; rows:any[]; reference:any; onChange(patch:any):void; sweep?:boolean; autoEdit?:boolean;
}) {
  const words=useWords(), groups=watchGroups(setting);
  const [editing,setEditing]=useState<string|null>(null), [undo,setUndo]=useState<any>(null);
  const timer=useRef<ReturnType<typeof setTimeout>|null>(null);
  useEffect(()=>()=>{if(timer.current)clearTimeout(timer.current);},[]);
  useEffect(()=>{if(autoEdit&&groups.length)setEditing(groups[0].id);},[autoEdit]);
  const write=(next:any[])=>onChange({groups:next});
  const patch=(key:string,values:any)=>write(groups.map((g:any)=>g.id===key?{...g,...values}:g));
  function remove(key:string) {
    const at=groups.findIndex((g:any)=>g.id===key);setUndo({group:groups[at],at});
    write(groups.filter((g:any)=>g.id!==key));setEditing(null);
    if(timer.current)clearTimeout(timer.current);timer.current=setTimeout(()=>setUndo(null),8000);
  }
  function addGroup() {
    const key=crypto.randomUUID();write([...groups,{id:key,name:'',cap:null,notify:true,buy:false,reminder:{}}]);setEditing(key);
  }
  // Sweeping needs an account; for guests the box shows only on groups that already sweep.
  const several=groups.length>1;
  return <div className="watch-groups">
    {groups.map((g:any,index:number)=>{
      const selected=reminderSelection(rows,id,g,reference), tokens=reminderTokens(g.reminder,document.documentElement.lang==='en');
      const canBuy=sweepable(g);
      const label=g.name||(several?words(`条件 ${index+1}`,`Group ${index+1}`):''), tracking=trackOnly(g);
      return <Fragment key={g.id}>
        <div className="wg-rule" data-watch-group={g.id}>
          <div className="wg-description">{index>0&&<i className="wg-or">{words('或','or')}</i>}{label&&<b>{label}</b>}
            <div className="wg-chips"><span>{g.reminder.percentile!=='all'?words(`最低 ${g.reminder.percentile}%`,`Lowest ${g.reminder.percentile}%`):g.cap===null?words('价格不限','Any price'):`≤ ${g.cap.toLocaleString()}`}</span>{tokens.map((t:any)=><span key={t.key}>{t.label}</span>)}</div>
            <small>{tracking?words('只看价格','Prices only'):`${selected.rows.length} ${words('条符合','matching')}`}</small>
          </div>
          <div className="wg-actions"><label><input type="checkbox" checked={g.notify} onChange={e=>patch(g.id,{notify:e.target.checked})}/>{words('提醒','Alert')}</label>
          {(sweep||g.buy)&&<label title={!canBuy?words('请选择价格条件，并排除属性未知条件','Choose a price condition and remove unknown-stats filters'):undefined}><input type="checkbox" checked={g.buy} disabled={!canBuy&&!g.buy} onChange={e=>patch(g.id,{buy:e.target.checked})}/>{words('扫货','Sweep')}</label>}
          <button type="button" className="wg-link" aria-expanded={editing===g.id} onClick={()=>setEditing(editing===g.id?null:g.id)}>{words('编辑','Edit')}</button>
          <button type="button" className="wg-link" aria-label={words(`删除条件组 ${g.name||index+1}`,`Delete group ${g.name||index+1}`)} onClick={()=>remove(g.id)}>{words('删除','Delete')}</button></div>
        </div>
        {editing===g.id&&<div className={'watch-group-editor'+(several?'':' single')}>
          {several&&<label className="wg-name">{words('名称','Name')}<input aria-label={words('条件组名称','Group name')} maxLength={40} value={g.name} placeholder={words('例如：白板自用','e.g. Clean equipment')} onChange={e=>patch(g.id,{name:e.target.value})}/></label>}
          <WatchReminder id={id} name={name} setting={g} rows={rows} reference={reference} onChange={v=>{const next={...g,...v};if(tracking&&!trackOnly({...next,notify:false}))next.notify=true;if(!sweepable(next))next.buy=false;patch(g.id,next);}}/>
          <button className="wg-link" onClick={()=>setEditing(null)}>{words('完成','Done')}</button>
          <button type="button" className="wg-link wg-add" disabled={groups.length>=12} onClick={addGroup}>{words('＋ 另一组条件','＋ Another group')}</button></div>}
      </Fragment>;
    })}
    {undo&&<div className="wg-undo" role="status">{words('条件组已删除','Group deleted')} <button onClick={()=>{const next=[...groups];next.splice(Math.min(undo.at,next.length),0,undo.group);write(next);setUndo(null);}}>{words('撤销','Undo')}</button></div>}
    {!groups.length&&<div className="wg-footer"><button className="wg-link" onClick={addGroup}>{words('＋ 添加条件','＋ Add conditions')}</button></div>}
  </div>;
}
