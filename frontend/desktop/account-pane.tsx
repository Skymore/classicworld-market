import { useEffect, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import type { Device } from '../src/lib/sweep-labels';
import { ago, full, monthDay, updateLabel } from './format';
import { tr } from './i18n';
import { useDevices, type Run, type Shell, type WorkspaceStatus } from './workspace';

const MAX_NAME = 40;

export default function AccountPane({ status, busy, run, login, shell }: { status: WorkspaceStatus; busy: boolean; run: Run; login(): void; shell: Shell }) {
  if (!status.linked) return <div className="native-account" data-account-pane="signed-out"><h2>{tr('登录枫叶市集', 'Sign in to Maple Market')}</h2>
    <p>{tr('关注和扫货在电脑与网页间同步', 'Watch lists and sweeps sync between this PC and the website')}</p>
    <button className="ui-btn primary" disabled={busy} onClick={login}>{tr('登录', 'Sign in')}</button></div>;
  return <SignedIn status={status} busy={busy} run={run} shell={shell} />;
}

function SignedIn({ status, busy, run, shell }: { status: WorkspaceStatus; busy: boolean; run: Run; shell: Shell }) {
  const name = status.device?.name || '', nickname = status.account?.nickname || tr('已登录', 'Signed in');
  const [draft, setDraft] = useState(name), [renamed, setRenamed] = useState(false);
  useEffect(() => setDraft(name), [name]);
  useEffect(() => { if (!renamed) return; const timer = setTimeout(() => setRenamed(false), 2000); return () => clearTimeout(timer); }, [renamed]);
  const { devices, failed } = useDevices(true, name);
  const here = devices?.find(d => d.id === status.device?.id);
  const clean = draft.trim(), canRename = !busy && clean !== '' && clean !== name && [...clean].length <= MAX_NAME;
  async function rename() { if (canRename && await run('rename', { name: clean })) setRenamed(true); }
  const sync = [
    shell.watch && tr(`关注 ${shell.watch.watches} 件`, `${shell.watch.watches} watched`) + ' · ' + (shell.watch.synced ? tr('已同步', 'Synced') : tr('同步中', 'Syncing')),
    shell.uploaded > 0 && tr(`本次已上传 ${full(shell.uploaded)} 条记录`, `${full(shell.uploaded)} records uploaded this session`),
  ].filter(Boolean).join(' · ');
  return <div className="account" data-account-pane="signed-in">
    <div className="account-head"><div className="avatar" aria-hidden="true">{[...nickname][0]}</div>
      <div><b>{nickname}</b>{here?.created_at && <small>{tr(`设备登录于 ${monthDay(here.created_at)}`, `Signed in on ${monthDay(here.created_at)}`)}</small>}</div>
      <button className="ui-btn" disabled={busy} onClick={() => run('logout')}>{tr('退出登录', 'Sign out')}</button></div>
    <div className="native-block" data-this-device>
      <div className="native-block-head"><b>{tr('本机', 'This PC')}</b><span>{[shell.version && `v${shell.version}`, updateLabel(shell.updates)].filter(Boolean).join(' · ')}</span></div>
      <div className="sweep-form"><span className="sweep-label">{tr('名称', 'Name')}</span>
        <input name="device_name" aria-label={tr('本机名称', 'Name of this PC')} maxLength={MAX_NAME} value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') rename(); }} />
        <button className="ui-btn" data-rename disabled={!canRename} onClick={rename}>{tr('改名', 'Rename')}</button>
        {renamed && <span className="saved" role="status">{tr('已改名', 'Renamed')}</span>}</div>
      {(shell.watch || shell.uploaded > 0) && <div className="sweep-form" data-sync><span className="sweep-label">{tr('同步', 'Sync')}</span><span className="sweep-sub">{sync}</span></div>}
    </div>
    <div className="native-block" data-devices>
      <div className="native-block-head"><b>{tr('这个账号的设备', 'Devices on this account')}</b><span>{devices?.length ? tr(`${devices.length} 台`, `${devices.length}`) : ''}</span></div>
      {devices === null ? <p className="workspace-note">{tr('正在读取…', 'Loading…')}</p> : failed ? <p className="workspace-note">{tr('设备列表暂不可用', 'Devices are unavailable right now')}</p>
        : devices.map(device => <DeviceRow key={device.id} device={device} here={device.id === status.device?.id} />)}
      <p className="workspace-note">{tr('在网站的「我的设备」里可以让设备退出', 'Sign a device out under My devices on the website')}</p>
    </div>
    <div className="native-block"><button className="text-link" data-open-website onClick={shell.openWebsite}>{tr('打开市集网站', 'Open the website')} <ArrowUpRight size={14} /></button></div>
  </div>;
}

function DeviceRow({ device, here }: { device: Device; here: boolean }) {
  const parts = [here && tr('本机', 'This PC'),
    device.online ? tr('在线', 'Online') : device.last_seen_at ? tr(`最后在线 ${ago(device.last_seen_at)}`, `Last online ${ago(device.last_seen_at)}`) : tr('离线', 'Offline'),
    device.client_version && `v${device.client_version}`, device.state?.sweep?.executor?.ready && tr('可以扫货', 'Can sweep')].filter(Boolean);
  return <div className="device-row" data-device={device.id}><i className={'sq-dot' + (device.online ? '' : ' off')} aria-hidden="true" />
    <b>{device.name}</b><span className="sweep-sub">{parts.join(' · ')}</span></div>;
}
