# Player departures and expired offers

Collector v0.6.7 forwards **explicit** player departure evidence. For the current
protocol, player entry is `0x22d`: the character ID is at byte 6 (the handle at
byte 2 is a different ID), and the length-prefixed character name starts at 18.
The observed extended-handle layout has a zero high handle word and shifts those
fields to 10 and 22; its four captured identities were checked against shop-owner
records. Malformed/unrecognized player layouts invalidate the entire roster.
Departure is exactly six bytes, `0x22e` followed by the character ID. The legacy
opcode pair is `0x22a`/`0x22b`. A departure is accepted only after a valid entry
for that character in the same decoded map/session. Local captured entries were
cross-checked against 61 known shop-owner identities; all 61 matched.

Collector v0.6.11 also reconciles absent owners against complete map-entry rosters.
The decoded TCP stream must include a validated map entry, the roster prefix
`1fa/3/00`, all `22d` player entries, and the ordered initialization suffix
`209/12`, `ae/4`, `82/2`, `20f/7/zero`, `211/6/zero`. This is a strict observed
protocol-layout boundary, not a timer or a visual scan count. Unexpected or
malformed frames, missing prefix/suffix, decode gaps and unknown map layouts
cannot produce a complete snapshot. Ten seconds is a rejection bound only.

The observer's own character ID is read from the validated channel-entry
character block (equal IDs at 158/162 and ASCII name at 170) and included because
it is not a remote-player spawn. Portal entry retains it; a new connection or
unknown long entry must establish it again. Manual browsing uses the same path.

The server stores authenticated rosters per exact world/channel/room and
materializes missing known owners as `room_roster` absence evidence. Only quotes
strictly older than the map-entry start are invalidated. A present player is
retained even without a shop sign/click. Unknown shop owners are retained.
Delayed uploads are reconciled too; newer observations can become live again.
Rosters never use a scan-count, silence, age alone or a partially received list.

The authenticated endpoint accepts only structured identity, location and event
times. No packet bodies or local paths are uploaded. Duplicate events are
idempotent. Events target the exact world/channel/room/character and expire only
observations at or before the departure time. Replay applies the same rule so a
delayed upload cannot revive a withdrawn quote. A new, later shop observation
is live again. A departure never creates a sale.

A newer stall of another owner at (nearly) the same spot is a third kind of
evidence (`evidence_kind = 'stall_replaced'`, migration 0048). Stalls standing
together on one level are always at least 120px apart (no pair seen together is
closer), so a newer stall within 100px horizontally and 10px vertically, in the
same channel and room, proves the older shop closed even when no departure or
complete roster was read (about 1% of room visits miss their roster). The upload
that records the newer stall inserts a departure for the older owner at the newer
stall's time, and the usual expiry retires the older goods. It is skipped when
the older owner has a newer stall reading anywhere (they moved). The server runs
the same pass over every stall once at startup.

Expired rows are archived separately from `listings`; existing aggregate,
watchlist and alert queries continue to see live inventory only. Item pages
receive a separate `expired_listings` collection (latest 200 invalidated within
the quote window) and merge it for price/time presentation only. Prices, previous
stock, attributes and location remain visible with an Expired label. Price
ladders, room minima and available inventory exclude these rows.

Known shop owners can be toggled between shop title and character name with a
button. Unknown owners have no toggle. Links and buttons are siblings so touch,
keyboard, equipment expansion and realtime refresh remain independent.

Validation: `test_player_presence.py`, `test_market_passive.py`, Rust integration
tests `player_departures`/`shop_owners`, `server/tools/test_player_departures.py`
(throwaway database and real HTTP/SSE), and `web/tests/player-departures.e2e.mjs`.
