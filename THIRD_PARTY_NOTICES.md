# Third-party notices

- `msnet_reference/`: reference sources from https://github.com/zhyonc/msnet (MIT); original license retained in that directory. `classicworld_codec.py` refers to this implementation.
- `maple_crypto_constants.cs`, `maple_aes.cs`, and adapted algorithms in `probe_session_crypto.py` / `test_request_transforms.py`: MapleLib, copyright Snow and haha01haha01, GPL-3.0-or-later. Original source headers retained. See `COPYING.MapleLib` and https://github.com/hadeutscher/MapleLib . These notices do not grant a different license for those portions.
- `tools/market_bot_templates/`: small game UI template crops supplied by the user, for local image matching. MapleStory graphics remain the property of their rights holders; no independent artwork license is granted.
- Item names, icons, and catalogue data remain subject to their original sources' terms. Downloaded catalogues, market snapshots and third-party website copies are not included in this repository. The local catalogue builder refers to the public DVG GCW catalogue (https://mxdgcw.dvg.cn) and Mapledex CW GMS_COT2_2026-08-11 reference (https://kafuffu20.com/classic-world/); source/version links and translation provenance are retained locally.

No blanket license for original project code is selected yet. Review third-party obligations before any public redistribution.

- WinDivert 2.2.2, Copyright Basil (basil00), dynamically loaded under LGPL-3.0: https://github.com/basil00/WinDivert/tree/v2.2.2 . Windows bundles include the unmodified official x64 DLL/driver, COPYING.WinDivert and the corresponding source archive. fetch_windivert.ps1 pins archive hashes; only SNIFF | RECV_ONLY is used.
# WZ format references for navigation

`market_map_resources.py` implements a read-only parser for the local client's
zero-IV PKG1 map metadata. Format behavior was checked against the publicly
documented MapleLib `WzBinaryReader`, `WzDirectory`, and `WzImageProperty`:
https://github.com/lastbattle/MapleLib . No MapleLib package is bundled by this
parser. Local map resources and calibration screenshots remain outside Git.
