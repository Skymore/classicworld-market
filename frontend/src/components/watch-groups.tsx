import { Fragment, useEffect, useRef, useState } from 'react';
import { useWords } from '../providers';
import WatchReminder from './watch-reminder';
import { watchGroups, reminderSelection, reminderTokens } from '/web/js/lib/watch-reminders.js?v=20261027-watch-groups-1';
import './watch-groups.css';

export default function WatchGroups({id,name,setting,rows,reference,onChange}: {
  id:number; name:string; setting:any; rows:any[]; reference:any; onChange(patch:any):void;
}) {
  const words=useWords(), groups=watchGroups(setting);
  const [editing,setEditing]=useState<string|null>(null), [undo,setUndo]=useState<any>(null);
  const timer=useRef<ReturnType<typeof setTimeout>|null>(null);
  useEffect(()=>()=>{if(timer.current)clearTimeout(timer.current);},[]);
  const write=(next:any[])=>onChange({groups:next});
  const patch=(key:string,values:any)=>write(groups.map((g:any)=>g.id===key?{...g,...values}:g));
  function remove(key:string) {
    const at=groups.findIndex((g:any)=>g.id===key);setUndo({group:groups[at],at});
    write(groups.filter((g:any)=>g.id!==key));setEditing(null);
    if(timer.current)clearTimeout(timer.current);timer.current=setTimeout(()=>setUndo(null),8000);
  }
  return <div className="watch-groups">
    {groups.length>1&&<div className="wg-hint">{words('满足任一组条件','Match any condition group')}</div>}
    {groups.map((g:any,index:number)=>{
      const selected=reminderSelection(rows,id,g,reference), tokens=reminderTokens(g.reminder,document.documentElement.lang==='en');
      const canBuy=g.cap!==null&&g.cap>0&&g.reminder.percentile==='all'&&g.reminder.equipment!=='missing';
      return <Fragment key={g.id}>
        {index>0&&<div className="wg-or">{words('或者','OR')}</div>}
        <div className="wg-rule" data-watch-group={g.id}>
          <div className="wg-description"><b>{g.name||words('默认条件','Default conditions')}</b><small>{selected.rows.length} {words('条命中','matches')}</small>
            <div className="wg-chips"><span>{g.reminder.percentile!=='all'?words(`最低 ${g.reminder.percentile}%`,`Lowest ${g.reminder.percentile}%`):g.cap===null?words('价格不限','Any price'):`≤ ${g.cap.toLocaleString()}`}</span>{tokens.map((t:any)=><span key={t.key}>{t.label}</span>)}</div>
          </div>
          <label><input type="checkbox" checked={g.notify} onChange={e=>patch(g.id,{notify:e.target.checked})}/>{words('提醒','Alert')}</label>
          <label title={!canBuy?words('扫货需设置固定最高价，并排除属性未知条件','Set a fixed price cap and remove unknown-stats filters to sweep'):undefined}><input type="checkbox" checked={g.buy} disabled={!canBuy&&!g.buy} onChange={e=>patch(g.id,{buy:e.target.checked})}/>{words('扫货','Sweep')}</label>
          <button type="button" className="wg-link" aria-expanded={editing===g.id} onClick={()=>setEditing(editing===g.id?null:g.id)}>{words('编辑','Edit')}</button>
          <button type="button" className="wg-link" aria-label={words(`删除条件组 ${g.name||index+1}`,`Delete group ${g.name||index+1}`)} onClick={()=>remove(g.id)}>{words('删除','Delete')}</button>
        </div>
        {editing===g.id&&<div className="watch-group-editor"><label className="wg-name">{words('条件组名称','Group name')}<input aria-label={words('条件组名称','Group name')} maxLength={40} value={g.name} placeholder={words('例如：白板自用','e.g. Clean equipment')} onChange={e=>patch(g.id,{name:e.target.value})}/></label>
          <WatchReminder id={id} name={name} setting={g} rows={rows} reference={reference} onChange={v=>{const next={...g,...v};if(next.cap===null||next.reminder.percentile!=='all'||next.reminder.equipment==='missing')next.buy=false;patch(g.id,next);}}/>
          <button className="wg-link" onClick={()=>setEditing(null)}>{words('完成','Done')}</button></div>}
      </Fragment>;
    })}
    {undo&&<div className="wg-undo" role="status">{words('条件组已删除','Group deleted')} <button onClick={()=>{const next=[...groups];next.splice(Math.min(undo.at,next.length),0,undo.group);write(next);setUndo(null);}}>{words('撤销','Undo')}</button></div>}
    <div className="wg-footer"><button className="wg-link" disabled={groups.length>=12} onClick={()=>{const key=crypto.randomUUID();write([...groups,{id:key,name:'',cap:null,notify:true,buy:false,reminder:{}}]);setEditing(key);}}>{groups.length?words('＋ 另一组条件','＋ Another group'):words('＋ 添加条件组','＋ Add conditions')}</button>
      <label>{words('本轮最多买','Session limit')}<input aria-label={words(`${name}本轮购买上限`,`${name} session quantity limit`)} type="number" min={1} max={9999} step={1} value={setting.buyLimit??1} onChange={e=>{const n=Number(e.target.value);if(Number.isInteger(n)&&n>=1&&n<=9999)onChange({buyLimit:n});}}/>{words('件','units')}</label></div>
  </div>;
}
