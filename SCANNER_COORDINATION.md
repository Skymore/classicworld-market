# Unified scanner and room assignments

The Windows launcher embeds the collector and the scanner pinned in the `scanner`
Git submodule. Capture, upload, local alerts, account linking, owner/history repairs
and update checks continue while automatic scanning is stopped. Automatic scanning
is opt-in. Existing `--home`, `--config` and `--folder` paths are preserved, including
after an automatic update.

Clone with `--recurse-submodules`. Install `requirements-shared.txt`. Build with
`build_shared_client.ps1 -WinDivert <official-x64-directory> -WinDivertSource <corresponding-source.zip>`.
The build stages the two independent runtime dependency trees and rejects module
collisions, so older collector modules in the scanner repository cannot shadow the
current collector. The release retains the `ClassicWorldCollector.exe` update
identity. Keep ZIP below 80 MiB and expanded content below 300 MiB for old updaters.
No game files, account settings, screenshots, captures or logs belong in either Git
repository or release source archives.

## Assignment protocol

Authenticated collector tokens use `/api/v1/scanner/{claim,heartbeat,complete,release}`.
Each scanner start generates a fresh random session. A worker claims exactly one
room, finishes it, then claims again. Rooms 1–20 are ordered by oldest completion,
with never-scanned rooms first. Existing assignments are not shuffled when people
join. When every room is leased, new workers wait. Manual collectors do not claim.

PostgreSQL serializes allocation and renewal transactions with a dedicated advisory
lock. Each room has a random lease token, collector ID, session ID and expiry.
Every renewal/completion/release checks all three identifiers and the expiry;
an expired lease can never be renewed, even by the same collector.

Heartbeat every 5 seconds, server expiry after 30 seconds. A failed heartbeat stops
the input loop immediately. Input guards additionally expire locally after 15
seconds measured from request start, so delayed responses or a suspended monitor
cannot extend input beyond the server's lease. Explicit release runs after the route
has stopped and released keys. Crashes/network loss are recovered by lease expiry.
Five seconds without an established game connection stops scanning too; normal
short channel transitions are tolerated. Pausing relinquishes the task; restart
claims afresh and does not reuse another worker's checkpoint.

Each room starts at CH1. Three verified empty channels switch the plan to CH40
descending. Three further empty channels or reaching the forward boundary ends
the room. Preparing/unresolved shops and unavailable channels never count as empty.
Direction and the forward boundary are persisted for standalone scanner resumes.
Cloud leases always start a fresh room scan; stale local progress cannot reserve it.

Validation: scanner unit/regression suite, collector/updater packaged tests and
`server/crates/market-web/tests/scan_assignments.rs` against a disposable PostgreSQL
database. The database test covers concurrent claims, same-session retries,
cross-collector denial, expiry/reassignment, old-session fencing and next-room order.
