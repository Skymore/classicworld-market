"""Windows-only elevated PowerShell, fenced by a kill-on-close Job Object."""
import base64
import ctypes
from ctypes import wintypes as w
import os
import subprocess
import tempfile
import threading
import time


def elevated():
    return os.name == 'nt' and bool(ctypes.windll.shell32.IsUserAnAdmin())


def run(script, cancel, timeout=60):
    if not elevated():
        raise PermissionError('远程调试需要采集器已获得管理员权限')
    import msvcrt
    k = ctypes.WinDLL('kernel32', use_last_error=True)
    class STARTUPINFO(ctypes.Structure):
        _fields_ = [('cb',w.DWORD),('reserved',w.LPWSTR),('desktop',w.LPWSTR),('title',w.LPWSTR),
            ('x',w.DWORD),('y',w.DWORD),('cx',w.DWORD),('cy',w.DWORD),('cols',w.DWORD),('rows',w.DWORD),
            ('fill',w.DWORD),('flags',w.DWORD),('show',w.WORD),('reserved_size',w.WORD),('reserved_bytes',ctypes.c_void_p),
            ('stdin',w.HANDLE),('stdout',w.HANDLE),('stderr',w.HANDLE)]
    class PROCESSINFO(ctypes.Structure):
        _fields_=[('process',w.HANDLE),('thread',w.HANDLE),('pid',w.DWORD),('tid',w.DWORD)]
    class BASIC(ctypes.Structure):
        _fields_=[('process_time',ctypes.c_longlong),('job_time',ctypes.c_longlong),('flags',w.DWORD),
            ('min_ws',ctypes.c_size_t),('max_ws',ctypes.c_size_t),('active',w.DWORD),('affinity',ctypes.c_size_t),('priority',w.DWORD),('scheduling',w.DWORD)]
    class IO(ctypes.Structure):
        _fields_=[(name,ctypes.c_ulonglong) for name in ('read_ops','write_ops','other_ops','read_bytes','write_bytes','other_bytes')]
    class LIMITS(ctypes.Structure):
        _fields_=[('basic',BASIC),('io',IO),('process_mem',ctypes.c_size_t),('job_mem',ctypes.c_size_t),('peak_process',ctypes.c_size_t),('peak_job',ctypes.c_size_t)]
    k.CreateJobObjectW.argtypes=[ctypes.c_void_p,w.LPCWSTR]; k.CreateJobObjectW.restype=w.HANDLE
    k.SetInformationJobObject.argtypes=[w.HANDLE,ctypes.c_int,ctypes.c_void_p,w.DWORD]; k.SetInformationJobObject.restype=w.BOOL
    k.AssignProcessToJobObject.argtypes=[w.HANDLE,w.HANDLE]; k.AssignProcessToJobObject.restype=w.BOOL
    k.CreateProcessW.argtypes=[w.LPCWSTR,w.LPWSTR,ctypes.c_void_p,ctypes.c_void_p,w.BOOL,w.DWORD,ctypes.c_void_p,w.LPCWSTR,ctypes.POINTER(STARTUPINFO),ctypes.POINTER(PROCESSINFO)]; k.CreateProcessW.restype=w.BOOL
    k.ResumeThread.argtypes=[w.HANDLE];k.ResumeThread.restype=w.DWORD
    k.WaitForSingleObject.argtypes=[w.HANDLE,w.DWORD];k.WaitForSingleObject.restype=w.DWORD
    k.TerminateJobObject.argtypes=[w.HANDLE,w.UINT];k.TerminateJobObject.restype=w.BOOL
    k.TerminateProcess.argtypes=[w.HANDLE,w.UINT];k.TerminateProcess.restype=w.BOOL
    k.GetExitCodeProcess.argtypes=[w.HANDLE,ctypes.POINTER(w.DWORD)];k.GetExitCodeProcess.restype=w.BOOL
    k.CloseHandle.argtypes=[w.HANDLE];k.CloseHandle.restype=w.BOOL
    def check(value):
        if not value: raise ctypes.WinError(ctypes.get_last_error())
        return value
    job=check(k.CreateJobObjectW(None,None)); pi=PROCESSINFO(); reason=''
    try:
        limits=LIMITS();limits.basic.flags=0x2000 | 0x8;limits.basic.active=32
        check(k.SetInformationJobObject(job,9,ctypes.byref(limits),ctypes.sizeof(limits)))
        # A private temporary file avoids an unbounded pipe read and deadlock.
        with tempfile.TemporaryFile() as output, open(os.devnull,'rb') as stdin:
            out_handle=msvcrt.get_osfhandle(output.fileno()); in_handle=msvcrt.get_osfhandle(stdin.fileno())
            si=STARTUPINFO();si.cb=ctypes.sizeof(si);si.flags=0x100;si.stdin=in_handle;si.stdout=si.stderr=out_handle
            exe=os.path.join(os.environ.get('SystemRoot',r'C:\Windows'),'System32','WindowsPowerShell','v1.0','powershell.exe')
            code="[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); $ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue';\n"+script
            args=subprocess.list2cmdline([exe,'-NoLogo','-NoProfile','-NonInteractive','-OutputFormat','Text','-EncodedCommand',base64.b64encode(code.encode('utf-16le')).decode()])
            if cancel.is_set(): return {'output':'已终止','exit_code':-1}
            os.set_handle_inheritable(out_handle,True);os.set_handle_inheritable(in_handle,True)
            try: check(k.CreateProcessW(exe,ctypes.create_unicode_buffer(args),None,None,True,0x08000000|0x4,None,tempfile.gettempdir(),ctypes.byref(si),ctypes.byref(pi)))
            finally: os.set_handle_inheritable(out_handle,False);os.set_handle_inheritable(in_handle,False)
            # No script instruction can run before containment succeeds.
            if not k.AssignProcessToJobObject(job,pi.process):
                k.TerminateProcess(pi.process,1);raise ctypes.WinError(ctypes.get_last_error())
            if cancel.is_set(): k.TerminateJobObject(job,1)
            elif k.ResumeThread(pi.thread)==0xffffffff: raise ctypes.WinError(ctypes.get_last_error())
            deadline=time.monotonic()+timeout
            while k.WaitForSingleObject(pi.process,50)==258:
                if cancel.is_set() or time.monotonic()>=deadline or os.fstat(output.fileno()).st_size>1024*1024:
                    reason='\n[已终止：用户取消、超时或输出超限]';k.TerminateJobObject(job,1);break
            k.WaitForSingleObject(pi.process,2000)
            # Also terminate any child process left behind after shell exit.
            k.TerminateJobObject(job,1)
            result=w.DWORD();check(k.GetExitCodeProcess(pi.process,ctypes.byref(result)))
            output.seek(0);data=output.read(48000).decode('utf-8',errors='replace')
            # Bound UTF-8 bytes, including replacement characters.
            data=data.encode('utf-8')[:60000].decode('utf-8',errors='ignore')
            return {'output':data+reason,'exit_code':int(result.value)}
    finally:
        k.TerminateJobObject(job,1)
        for handle in (pi.thread,pi.process,job):
            if handle:k.CloseHandle(handle)
