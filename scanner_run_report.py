"""Summarize actual recorded progress; never certify a 24-hour run from uptime."""
import argparse
from datetime import datetime
import json
from pathlib import Path


def report(home):
    events=[]
    for pattern in ('scan-recovery.jsonl*','scan-watchdog.jsonl*'):
        for path in Path(home).glob(pattern):
            for line in path.read_text(encoding='utf-8',errors='replace').splitlines():
                try:
                    event=json.loads(line)
                    event['_time']=datetime.fromisoformat(event['time']).timestamp()
                    events.append(event)
                except (KeyError,TypeError,ValueError):
                    continue
    events.sort(key=lambda row:row['_time'])
    progress=[e for e in events if e.get('event')=='progress']
    samples=[e for e in events if e.get('event')=='resources']
    intervals={}
    for before,after in zip(samples,samples[1:]):
        # Missing samples are unknown, not successful scan time.
        gap=after['_time']-before['_time']
        state=before.get('phase') if gap<=65 else 'unknown'
        intervals[state or 'unknown']=intervals.get(state or 'unknown',0)+gap
    return dict(acceptance='pending_real_run_review',
        first_event=events[0]['time'] if events else None,last_event=events[-1]['time'] if events else None,
        recorded_span_seconds=events[-1]['_time']-events[0]['_time'] if events else 0,
        confirmed_progress=len(progress),completed_tasks=sum(e.get('step')=='complete' for e in progress),
        recovery_attempts=sum(e.get('event')=='recovery_begin' for e in events),
        process_restarts=sum(e.get('event')=='process_recovery_end' for e in events),
        longest_gap_between_progress_seconds=max((b['_time']-a['_time'] for a,b in zip(progress,progress[1:])),default=None),
        sampled_state_seconds=intervals,
        resources={key:dict(first=values[0],last=values[-1],peak=max(values))
                   for key in ('memory_bytes','handles','threads','free_disk_bytes','pending_uploads')
                   if (values:=[e[key] for e in samples if isinstance(e.get(key),(int,float))])},
        note='Sampled scanning state is not proof of actual scan time. Review progress, outages and log coverage; elapsed time alone never passes acceptance.')


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--home',type=Path,required=True)
    args=parser.parse_args()
    print(json.dumps(report(args.home),ensure_ascii=False,indent=2))
