import { useState } from 'react';
import { useWords } from '../providers';
import { watchGroups, reminderTokens } from '/web/js/lib/watch-reminders.js?v=20261106-server-caps';
import { MAX_LISTS, listItems } from '/web/js/lib/watch-lists.js';
import { sweepable } from './watch-groups';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';
import './watch-lists.css';

export type WatchList = { id: string; name: string; items: number[] };
type Props = {
  lists: WatchList[]; selected: string; ids: number[]; settings: any;
  name(id: number): string; onSelect(id: string): void; onLists(lists: WatchList[]): void;
  onSettings(settings: any): void; canSweep: boolean;
};
export default function WatchLists({lists, selected, ids, settings, name, onSelect, onLists, onSettings, canSweep}: Props) {
  const words = useWords();
  const [menu,setMenu] = useState(false);
  const [dialog,setDialog] = useState<'create'|'rename'|'delete'|'batch'|null>(null);
  const [title,setTitle] = useState(''), [error,setError] = useState('');
  const [draft,setDraft] = useState<any[]>([]);
  const current = lists.find(list=>list.id===selected);
  const visible: number[] = listItems(lists,ids,selected);
  const label = selected==='all'?words('全部关注','All watched items'):current?.name||words('默认清单','Default list');
  const alerting = visible.filter(id=>watchGroups(settings[id]).some((g:any)=>g.notify)).length;
  const buying = visible.filter(id=>watchGroups(settings[id]).some((g:any)=>g.buy)).length;
  const close = ()=>{setDialog(null);setError('');};
  function open(kind: typeof dialog) {
    setMenu(false);setError('');setTitle(kind==='rename'?current?.name||'':'');
    if(kind==='batch')setDraft(visible.map(id=>({id, original:JSON.stringify(settings[id]), limit:String(settings[id]?.buyLimit??1),
      groups:watchGroups(settings[id]).map((g:any)=>({...g,price:g.cap===null?'':String(g.cap)}))})));
    setDialog(kind);
  }
  function bulk(field:'notify'|'buy', value:boolean) {
    const next={...settings};
    for(const id of visible)next[id]={...settings[id],groups:watchGroups(settings[id]).map((g:any)=>({...g,[field]:value}))};
    onSettings(next);setMenu(false);
  }
  function saveName() {
    const value=title.trim();
    if(!value||[...value].length>20||/[\x00-\x1f\x7f]/.test(value))return setError(words('请输入 1–20 字的名称','Enter a name of 1–20 characters'));
    if(lists.some(list=>list.name===value&&(dialog!=='rename'||list.id!==selected)))return setError(words('清单名称已存在','That name is already used'));
    if(dialog==='create') {
      if(lists.length>=MAX_LISTS)return;
      const id=crypto.randomUUID();onLists([...lists,{id,name:value,items:[]}]);onSelect(id);
    } else {
      if(!current)return setError(words('清单已更新，请重新打开','The list changed; reopen it'));
      onLists(lists.map(list=>list.id===selected?{...list,name:value}:list));
    }
    close();
  }
  function patch(id:number, values:any) {setDraft(old=>old.map(item=>item.id===id?{...item,...values}:item));}
  function patchGroup(id:number,key:string,values:any) {
    setDraft(old=>old.map(item=>item.id!==id?item:{...item,groups:item.groups.map((g:any)=>{
      if(g.id!==key)return g;
      const next={...g,...values};next.cap=next.price===''?null:Number(next.price);
      if(!sweepable(next))next.buy=false;
      return next;
    })}));
  }
  function saveBatch() {
    if(draft.some(item=>!ids.includes(item.id)||item.original!==JSON.stringify(settings[item.id])))
      return setError(words('物品条件已更新，请重新打开','Item rules changed; reopen the editor'));
    const next={...settings};
    for(const item of draft) {
      const limit=Number(item.limit);
      if(item.limit===''||!Number.isInteger(limit)||limit<0||limit>9999)return setError(words('请检查购买数量','Check purchase quantities'));
      const groups=item.groups.map(({price,...g}:any)=>({...g,cap:price===''?null:Number(price)}));
      if(groups.some((g:any)=>(g.cap!==null&&(!Number.isFinite(g.cap)||g.cap<0||g.cap>1e15))||(g.buy&&!sweepable(g))))
        return setError(words('请检查价格条件','Check price conditions'));
      next[item.id]={...settings[item.id],buyLimit:limit,groups};
    }
    onSettings(next);close();
  }
  return <>
    <div className="watch-lists" data-watch-lists>
      <div className="wl-tools">
        <select aria-label={words('关注清单','Watch list')} value={selected} onChange={e=>{onSelect(e.target.value);setMenu(false);}}>
          <option value="all">{words('全部关注','All watched items')} · {ids.length}</option>
          <option value="default">{words('默认清单','Default list')} · {listItems(lists,ids,'default').length}</option>
          {lists.map(list=><option key={list.id} value={list.id}>{list.name} · {listItems(lists,ids,list.id).length}</option>)}
        </select>
        <button className="btn" onClick={()=>open('create')} disabled={lists.length>=MAX_LISTS}>{words('＋ 新建清单','＋ New list')}</button>
        <button className="btn" onClick={()=>setMenu(!menu)} aria-expanded={menu}>{words('清单操作','List actions')}</button>
        {canSweep&&<button className="btn" disabled={!visible.length} onClick={()=>open('batch')}>{words('批量设置扫货','Edit sweep rules')}</button>}
      </div>
      <div className="wl-summary"><b>{label}</b><span>{words(`提醒 ${alerting}/${visible.length} · 扫货 ${buying}/${visible.length}`,`Alerts ${alerting}/${visible.length} · Sweep ${buying}/${visible.length}`)}</span></div>
      {menu&&<div className="wl-actions">
        <button className="btn" disabled={!visible.length} onClick={()=>bulk('notify',true)}>{words('全部开启提醒','Enable all alerts')}</button>
        <button className="btn" disabled={!visible.length} onClick={()=>bulk('notify',false)}>{words('全部关闭提醒','Disable all alerts')}</button>
        {canSweep&&<button className="btn" disabled={!visible.length} onClick={()=>bulk('buy',false)}>{words('全部关闭扫货','Disable all sweeping')}</button>}
        {current&&<><button className="btn" onClick={()=>open('rename')}>{words('重命名','Rename')}</button><button className="btn" onClick={()=>open('delete')}>{words('删除清单','Delete list')}</button></>}
      </div>}
    </div>
    <Dialog open={dialog!==null} onOpenChange={value=>{if(!value)close();}}>
      <DialogContent className={'wl-dialog'+(dialog==='batch'?' wl-batch':'')} aria-describedby={undefined}>
        <div className="stall-bar"><DialogTitle>{dialog==='create'?words('新建清单','New list'):dialog==='rename'?words('重命名清单','Rename list'):dialog==='delete'?words('删除清单','Delete list'):words(`批量设置扫货 · ${label}`,`Sweep rules · ${label}`)}</DialogTitle></div>
        <form onSubmit={event=>{event.preventDefault();dialog==='batch'?saveBatch():dialog==='delete'?(onLists(lists.filter(list=>list.id!==selected)),onSelect('default'),close()):saveName();}}>
          {dialog==='create'||dialog==='rename'?<label className="wl-name">{words('清单名称','List name')}<input autoFocus value={title} maxLength={20} required onChange={e=>setTitle(e.target.value)}/></label>:dialog==='delete'?<p className="wl-delete">{words('物品将移回默认清单，保留原有条件。','Items return to the default list with their rules intact.')}</p>:<div className="wl-batch-body">
            {draft.map(item=><section className="wl-batch-item" data-batch-item={item.id} key={item.id}>
              <div className="wl-batch-head"><b>{name(item.id)}</b><label>{words('本轮最多买','Per run')}{item.limit!=='0'&&<input type="number" min={1} max={9999} step={1} required value={item.limit} aria-label={words(`${name(item.id)}本轮购买上限`,`${name(item.id)} session quantity limit`)} onChange={e=>patch(item.id,{limit:e.target.value})}/>}</label>
                <label><input type="checkbox" checked={item.limit==='0'} onChange={e=>patch(item.id,{limit:e.target.checked?'0':'1'})}/>{words('不限','Unlimited')}</label></div>
              {item.groups.map((g:any,index:number)=><div className="wl-batch-rule" key={g.id}>
                <span className="wl-rule-name">{g.name||words(`条件 ${index+1}`,`Rule ${index+1}`)}</span>
                <select aria-label={words(`${name(item.id)}条件 ${index+1}价格`,`${name(item.id)} rule ${index+1} price`)} value={g.reminder.percentile} onChange={e=>patchGroup(item.id,g.id,{reminder:{...g.reminder,percentile:e.target.value}})}>
                  <option value="all">{words('最高单价','Max unit price')}</option>{['10','25','50'].map(p=><option key={p} value={p}>{words(`最低 ${p}%`,`Lowest ${p}%`)}</option>)}
                </select>
                {g.reminder.percentile==='all'&&<input type="number" step="any" min={0.000001} max={1e15} value={g.price} placeholder={words('未设置','Not set')} aria-label={words(`${name(item.id)}条件 ${index+1}最高单价`,`${name(item.id)} rule ${index+1} max unit price`)} onChange={e=>patchGroup(item.id,g.id,{price:e.target.value})}/>}
                <label><input type="checkbox" checked={g.buy} disabled={!sweepable(g)&&!g.buy} onChange={e=>patchGroup(item.id,g.id,{buy:e.target.checked})}/>{words('扫货','Sweep')}</label>
                {reminderTokens(g.reminder).length>0&&<small>{reminderTokens(g.reminder,document.documentElement.lang==='en').map((token:any)=>token.label).join(' · ')}</small>}
              </div>)}
              {!item.groups.length&&<button type="button" className="btn" onClick={()=>patch(item.id,{groups:[{id:crypto.randomUUID(),name:'',cap:null,price:'',notify:false,buy:false,reminder:{percentile:'all',equipment:'all'}}]})}>{words('添加条件','Add rule')}</button>}
            </section>)}
          </div>}
          {error&&<p className="wl-error" role="alert">{error}</p>}
          <div className="wl-dialog-foot"><button type="button" className="btn" onClick={close}>{words('取消','Cancel')}</button><button type="submit" className="btn primary">{dialog==='delete'?words('确认删除','Delete'):words('保存','Save')}</button></div>
        </form>
      </DialogContent>
    </Dialog>
  </>;
}
