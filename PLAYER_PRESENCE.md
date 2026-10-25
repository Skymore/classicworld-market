# Player departures and expired offers

Collector v0.6.7 forwards **explicit** player departure evidence. For the current
protocol, player entry is `0x22d`: the character ID is at byte 6 (the handle at
byte 2 is a different ID), and the length-prefixed character name starts at 18.
Departure is exactly six bytes, `0x22e` followed by the character ID. The legacy
opcode pair is `0x22a`/`0x22b`. A departure is accepted only after a valid entry
for that character in the same decoded map/session. Local captured entries were
cross-checked against 61 known shop-owner identities; all 61 matched.

Changing maps, reconnecting, capture gaps, silence and unobserved roster entries
do not produce departures. We do **not** claim that a partially received roster
proves that every absent owner has left. Historical offers without affirmative
departure evidence remain unconfirmed, rather than being expired by age.

The authenticated endpoint accepts only structured identity, location and event
times. No packet bodies or local paths are uploaded. Duplicate events are
idempotent. Events target the exact world/channel/room/character and expire only
observations at or before the departure time. Replay applies the same rule so a
delayed upload cannot revive a withdrawn quote. A new, later shop observation
is live again. A departure never creates a sale.

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
