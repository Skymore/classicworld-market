"""Windows foreground keyboard input with explicit hardware scan codes.

Uses the documented SendInput API, not a driver or game process hook.
https://learn.microsoft.com/windows/win32/api/winuser/ns-winuser-keybdinput
Caller is responsible for foreground checks and releasing keys in finally.
"""
import ctypes

WORD=ctypes.c_uint16
DWORD=ctypes.c_uint32
LONG=ctypes.c_int32
PTR=ctypes.c_size_t


class KeyboardInput(ctypes.Structure):
    _fields_=[('vk',WORD),('scan',WORD),('flags',DWORD),('time',DWORD),('extra',PTR)]


class MouseInput(ctypes.Structure):
    _fields_=[('dx',LONG),('dy',LONG),('data',DWORD),('flags',DWORD),('time',DWORD),('extra',PTR)]


class InputUnion(ctypes.Union):
    _fields_=[('keyboard',KeyboardInput),('mouse',MouseInput)]


class Input(ctypes.Structure):
    _fields_=[('type',DWORD),('payload',InputUnion)]


SCANS={'left':(0x4b,True),'right':(0x4d,True),'up':(0x48,True),
       'down':(0x50,True),'space':(0x39,False),'alt':(0x38,False),'ctrl':(0x1d,False)}


def keyboard_event(key, down):
    scan,extended=SCANS[key]
    event=Input();event.type=1
    event.payload.keyboard=KeyboardInput(0,scan,8 | int(extended) | (0 if down else 2),0,0)
    return event


def send_key(key, down):
    event=keyboard_event(key,down)
    user=ctypes.WinDLL('user32',use_last_error=True)
    user.SendInput.argtypes=[ctypes.c_uint,ctypes.POINTER(Input),ctypes.c_int]
    user.SendInput.restype=ctypes.c_uint
    if user.SendInput(1,ctypes.byref(event),ctypes.sizeof(event))!=1:
        raise OSError(ctypes.get_last_error(),'Keyboard input was not delivered')
