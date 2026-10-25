"""Observed ClassicWorld client movement layout, using map index 0x14.

Coordinates are client-reported world coordinates, not server acknowledgements.
Unknown fragment layouts are rejected, never guessed or partially consumed.
"""
import struct

MOVEMENT_INDEX = 0x14


def parse_movement(plain):
    if len(plain) < 36:
        raise ValueError('Short movement message')
    x, y, vx, vy, count = struct.unpack_from('<hhhhH', plain, 16)
    if not 1 <= count <= 256:
        raise ValueError('Invalid movement fragment count')
    offset = 26
    fragments = []
    for _ in range(count):
        if offset >= len(plain):
            raise ValueError('Truncated fragment')
        command = plain[offset]
        size = {0: 21, 1: 9, 10: 2}.get(command)
        if size is None:
            raise ValueError(f'Unverified movement fragment {command}')
        if offset+size > len(plain)-10:
            raise ValueError('Truncated movement fragment')
        part = dict(command=command)
        if command == 0:
            px, py, pvx, pvy, foothold = struct.unpack_from('<hhhhh', plain, offset+1)
            part.update(x=px, y=py, vx=pvx, vy=pvy, foothold=foothold,
                        stance=plain[offset+17])
        fragments.append(part)
        offset += size
    if len(plain)-offset != 10 or plain[offset] != 0x11:
        raise ValueError('Unverified movement trailer')
    # A relative jump after the final absolute fragment leaves no verified
    # final position. Wait for a subsequent absolute report instead.
    absolute = [i for i, fragment in enumerate(fragments) if fragment['command'] == 0]
    if not absolute or any(f['command'] == 1 for f in fragments[absolute[-1]+1:]):
        raise ValueError('No final absolute position')
    final = fragments[absolute[-1]]
    return dict(start=dict(x=x, y=y, vx=vx, vy=vy), end=final,
                fragments=fragments, source='client_movement', parser='cw_move_0x14_v1')
