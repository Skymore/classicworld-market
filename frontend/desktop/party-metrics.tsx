import { big, percent, type RunSummary } from './grind';
import { tr } from './i18n';

export function PartyMetrics({ run, compact = false }: { run: RunSummary; compact?: boolean }) {
  if (!run.combat?.length) return null;
  return <section className={compact ? 'ov-team party-metrics' : 'well grind-combat party-metrics'} aria-label={tr('队伍战斗统计', 'Party combat')}>
    <div className="party-heading"><b>{tr('同图队伍', 'Party')}</b><small>5m</small></div>
    <table><thead><tr><th>{tr('角色', 'Player')}</th><th>DPS</th><th>{tr('击杀', 'Kills')}</th><th>{tr('获得经验', 'EXP gained')}</th><th>{tr('击杀经验', 'Kill EXP')}</th></tr></thead>
      <tbody>{run.combat.map(row => <tr className={'ov-team-row' + (row.self ? ' own' : '')} key={row.character_id} data-self={row.self || undefined}>
        <td title={row.partial ? tr('数据不完整', 'Partial data') : row.name || ''}>{row.name || '—'}{row.away && <small>{tr('离开', 'Away')}</small>}</td>
        <td>{big(row.dps_5m)}</td><td>{big(row.kills_5m)}</td>
        <td title={row.exp_received_5m == null ? tr('本机未观测到队友获得经验', 'Party EXP not observed by this client') : tr('收益比＝获得经验 / 击杀基础经验', 'Yield = received EXP / base kill EXP')}>{big(row.exp_received_5m)}<small>{tr('收益', 'Yield')} {percent(row.exp_yield_5m, 0)}</small></td>
        <td>{big(row.kill_exp_5m)}<small>{tr('贡献', 'Share')} {percent(row.exp_contribution_5m, 0)}</small></td>
      </tr>)}</tbody></table>
  </section>;
}
