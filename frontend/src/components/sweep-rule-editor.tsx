import { useState } from 'react';
import { useWords } from '../providers';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';
import WatchReminder from './watch-reminder';
import { sweepable } from './watch-groups';

export function SweepRuleEditor({id,name,group,limit,bought,rows,reference,onSave,onClose}:{
  id:number;name:string;group:any;limit:number;bought:number;rows:any[];reference:any;
  onSave(group:any,limit:number):void;onClose():void;
}) {
  const words=useWords();
  const [draft,setDraft]=useState(()=>structuredClone(group));
  const [quantity,setQuantity]=useState(String(limit||1));
  const [unlimited,setUnlimited]=useState(limit===0);
  const [error,setError]=useState('');
  function save() {
    const count=unlimited?0:Number(quantity);
    if(!Number.isInteger(count)||count<0||count>9999||(!unlimited&&count===0))return setError(words('请输入 1–9999，或选择不限','Enter 1–9999, or select Unlimited'));
    if(!sweepable(draft))return setError(words('请选择可扫货的价格和条件','Choose a valid sweep price and conditions'));
    try {onSave(draft,count);onClose();} catch(e) {setError(e instanceof Error?e.message:String(e));}
  }
  return <Dialog open onOpenChange={open=>{if(!open)onClose();}}>
    <DialogContent className="sweep-dialog sweep-rule-dialog" aria-describedby={undefined}>
      <div className="stall-bar"><DialogTitle>{name}{group.name?` · ${group.name}`:''}</DialogTitle></div>
      <div className="sweep-rule-edit-body">
        <WatchReminder id={id} name={name} setting={draft} rows={rows} reference={reference} priceLabel={words('扫货价格','Sweep price')} showNotify={false} onChange={patch=>setDraft({...draft,...patch})}/>
        <div className="sweep-rule-quantity">
          <label>{words('本轮总上限','Run quantity limit')}{!unlimited&&<input type="number" min={1} max={9999} step={1} value={quantity} onChange={e=>setQuantity(e.target.value)}/>}</label>
          <label><input type="checkbox" checked={unlimited} onChange={e=>setUnlimited(e.target.checked)}/>{words('不限','Unlimited')}</label>
          <span>{words('已买','Bought')} {bought.toLocaleString()}</span>
        </div>
        {error&&<p role="alert" className="sweep-error">{error}</p>}
      </div>
      <div className="ffoot"><button className="btn" onClick={onClose}>{words('取消','Cancel')}</button><button className="btn primary" onClick={save}>{words('保存','Save')}</button></div>
    </DialogContent>
  </Dialog>;
}
