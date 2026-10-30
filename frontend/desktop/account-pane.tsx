import { useEffect, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import type { Device } from '../src/lib/sweep-labels';
import { ago, full, monthDay, updateLabel } from './format';
import { useDevices, type Run, type Shell, type WorkspaceStatus } from './workspace';

const MAX_NAME = 40;

export default function AccountPane({ status, busy, run, login, shell }: { status: WorkspaceStatus; busy: boolean; run: Run; login(): void; shell: Shell }) {
  if (!status.linked) return <div className="native-account" data-account-pane="signed-out"><h2>登录枫叶市集</h2><p>关注和扫货在电脑与网页间同步</p>
    <button className="ui-btn primary" disabled={busy} onClick={login}>登录</button></div>;
  return <SignedIn status={status} busy={busy} run={run} shell={shell} />;
}

function SignedIn({ status, busy, run, shell }: { status: WorkspaceStatus; busy: boolean; run: Run; shell: Shell }) {
  const name = status.device?.name || '', nickname = status.account?.nickname || '已登录';
  const [draft, setDraft] = useState(name), [renamed, setRenamed] = useState(false);
  useEffect(() => setDraft(name), [name]);
  useEffect(() => { if (!renamed) return; const timer = setTimeout(() => setRenamed(false), 2000); return () => clearTimeout(timer); }, [renamed]);
  const { devices, failed } = useDevices(true, name);
  const here = devices?.find(d => d.id === status.device?.id);
  const clean = draft.trim(), canRename = !busy && clean !== '' && clean !== name && [...clean].length <= MAX_NAME;
  async function rename() { if (canRename && await run('rename', { name: clean })) setRenamed(true); }
  return <div className="account" data-account-pane="signed-in">
    <div className="account-head"><div className="avatar" aria-hidden="true">{[...nickname][0]}</div>
      <div><b>{nickname}</b>{here?.created_at && <small>设备登录于 {monthDay(here.created_at)}</small>}</div>
      <button className="ui-btn" disabled={busy} onClick={() => run('logout')}>退出登录</button></div>
    <div className="native-block" data-this-device>
      <div className="native-block-head"><b>本机</b><span>{[shell.version && `v${shell.version}`, updateLabel(shell.updates)].filter(Boolean).join(' · ')}</span></div>
      <div className="sweep-form"><span className="sweep-label">名称</span>
        <input name="device_name" aria-label="本机名称" maxLength={MAX_NAME} value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') rename(); }} />
        <button className="ui-btn" data-rename disabled={!canRename} onClick={rename}>改名</button>
        {renamed && <span className="saved" role="status">已改名</span>}</div>
      {(shell.watch || shell.uploaded > 0) && <div className="sweep-form" data-sync><span className="sweep-label">同步</span><span className="sweep-sub">
        {[shell.watch && `关注 ${shell.watch.watches} 件 · ${shell.watch.synced ? '已同步' : '同步中'}`, shell.uploaded > 0 && `本次已上传 ${full(shell.uploaded)} 条记录`].filter(Boolean).join(' · ')}</span></div>}
    </div>
    <div className="native-block" data-devices>
      <div className="native-block-head"><b>这个账号的设备</b><span>{devices?.length ? `${devices.length} 台` : ''}</span></div>
      {devices === null ? <p className="workspace-note">正在读取…</p> : failed ? <p className="workspace-note">设备列表暂不可用</p>
        : devices.map(device => <DeviceRow key={device.id} device={device} here={device.id === status.device?.id} />)}
      <p className="workspace-note">在网站的「我的设备」里可以让设备退出</p>
    </div>
    <div className="native-block"><button className="text-link" data-open-website onClick={shell.openWebsite}>打开市集网站 <ArrowUpRight size={14} /></button></div>
  </div>;
}

function DeviceRow({ device, here }: { device: Device; here: boolean }) {
  const parts = [here && '本机', device.online ? '在线' : device.last_seen_at ? `最后在线 ${ago(device.last_seen_at)}` : '离线',
    device.client_version && `v${device.client_version}`, device.state?.sweep?.executor?.ready && '可以扫货'].filter(Boolean);
  return <div className="device-row" data-device={device.id}><i className={'sq-dot' + (device.online ? '' : ' off')} aria-hidden="true" />
    <b>{device.name}</b><span className="sweep-sub">{parts.join(' · ')}</span></div>;
}
