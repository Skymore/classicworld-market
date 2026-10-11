"""Describe actual collection readiness; a listening proxy is not a game session."""
import time


def classify(status, records, error=None, now=None):
    now = time.time() if now is None else now
    fresh = bool(status and 0 <= now-status.get('updated_at',0) < 8)
    sessions = [s for s in status.get('sessions',[]) if not s['closed']] if fresh else []
    ready = [s for s in sessions if s.get('map_ready') and not s.get('diagnostic_fault')]
    endpoints = []
    for r in records:
        if r.get('state') != 'ESTABLISHED': continue
        host,port = r['remote'].rsplit(':',1)
        if 8500 <= int(port) <= 8599:
            endpoints.append(dict(host=host,port=int(port)))
    covered = {(s['host'],s['port']) for s in ready}
    unmatched = [r for r in endpoints if (r['host'],r['port']) not in covered]
    if not fresh:
        state,message='offline','采集服务未运行或状态已过期；仅显示历史数据'
    elif unmatched:
        state,message='reconnect_required','检测到尚未被采集器接管的频道连接；需重连一次（换频道或重新登录）'
    elif ready:
        state,message='ready','游戏已接入并完成协议识别；可以手动逛摊'
    elif any(s.get('diagnostic_fault') for s in sessions):
        state,message='parse_error','游戏已接入，但商品解析发生错误；请检查采集日志'
    elif sessions:
        state,message='handshake','连接已进入采集器，正在等待协议识别'
    elif error:
        state,message='unknown','暂时无法检测游戏连接；不要将历史数据当作新采集'
    else:
        state,message='waiting','尚未检测到已接入的频道连接；等待进入游戏'
    return dict(state=state,message=message,checked_at=now,active_sessions=len(sessions),
                ready_sessions=len(ready),unmatched_channels=unmatched,network_error=error)
