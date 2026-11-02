"""No persistent consent: a player grants one visible 15-minute session."""
import threading
import time
import ctypes
from collector_http import request_json
from remote_debug_process import elevated, run


class RemoteDebug:
    def __init__(self, runtime):
        self.runtime=runtime
        self.lock=threading.RLock()
        self.cancel=threading.Event()
        self.session=None
        self.thread=None
        self.status={'active':False,'message':'','session':'','expires_at':0,'command':''}

    def view(self):
        with self.lock:return dict(self.status)

    def request(self, payload, cancel=True):
        config=self.runtime.configuration()
        if config['endpoint'].rstrip('/')!='https://mxd.ruit.me':raise ValueError('调试服务地址无效')
        return request_json(config['endpoint'].rstrip('/')+'/api/v1/remote-debug/client',payload,
            {'Authorization':'Bearer '+config['token'],'Content-Type':'application/json'},
            stop=self.cancel if cancel else None,timeout=6)

    def start(self, consent):
        if consent!='allow-admin-powershell-15-minutes':raise ValueError('请先确认管理员远程调试授权')
        if not elevated():raise PermissionError('请以管理员权限重新启动采集器后再授权')
        with self.lock:
            if self.thread and self.thread.is_alive():raise ValueError('上一调试会话尚未结束')
            self.cancel=threading.Event()
            self.status={'active':True,'message':'正在建立授权会话','session':'','expires_at':time.time()+900,'command':''}
            self.thread=threading.Thread(target=self.worker,name='remote-debug',daemon=True)
            self.thread.start()
            threading.Thread(target=self.guard,args=(self.cancel,time.monotonic()+900),name='debug-stop-guard',daemon=True).start()

    def guard(self, cancel, deadline):
        # Independent of polling/network and of the stopped scan input guard.
        while not cancel.wait(.05):
            if self.runtime.stop_event.is_set() or time.monotonic()>=deadline or ctypes.windll.user32.GetAsyncKeyState(0x78)&0x8000:
                self.stop()
                return

    def stop(self):
        # Local stop never waits for network; the job monitor reacts within 50ms.
        with self.lock:
            self.cancel.set()
            self.status.update(active=False,message='远程调试已终止',command='')

    def worker(self):
        session=None; execution=None; result={}; executed=set()
        deadline=time.monotonic()+900
        try:
            answer=self.request({'action':'open'})
            session=answer['session']
            with self.lock:
                self.session=session
                if not self.cancel.is_set():self.status.update(session=session,message='已授权运维执行管理员 PowerShell 命令')
            while not self.cancel.is_set() and not self.runtime.stop_event.is_set() and time.monotonic()<deadline:
                if execution and not execution.is_alive():
                    ack=self.request({'action':'result','session':session,**result})
                    if not ack.get('active') or ack.get('ack')!=result['command']:break
                    execution=None
                    with self.lock:self.status.update(message='命令已结束，等待运维',command='')
                answer=self.request({'action':'poll','session':session})
                if not answer.get('active'):break
                command=answer.get('command')
                if command:
                    if execution or command['id'] in executed:raise ValueError('拒绝重复调试指令')
                    if not isinstance(command.get('script'),str) or len(command['script'].encode())>8192:raise ValueError('无效调试指令')
                    executed.add(command['id'])
                    with self.lock:self.status.update(command=command['script'],message='正在执行管理员 PowerShell 命令')
                    result={'command':command['id']}
                    def execute(script=command['script'], target=result):
                        try: target.update(run(script,self.cancel))
                        except Exception as e: target.update(output=type(e).__name__+': '+str(e)[:1000],exit_code=-1)
                    execution=threading.Thread(target=execute,name='debug-powershell',daemon=True);execution.start()
                self.cancel.wait(2)
        except Exception:
            with self.lock:self.status['message']='调试连接中断，授权已撤销'
        finally:
            self.cancel.set()
            if execution:execution.join(timeout=4)
            with self.lock:
                self.session=None;self.status.update(active=False,command='')
                if self.status['message'] not in ('远程调试已终止','调试连接中断，授权已撤销'):self.status['message']='调试会话已结束，需重新授权'
            if session:
                try:self.request({'action':'close','session':session},cancel=False)
                except Exception:pass
