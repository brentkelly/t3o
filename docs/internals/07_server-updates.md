# Server updates

## Launcher ownership and compatibility

A [stable launcher](../../apps/server/src/serviceLauncher.ts) owns the runtime selected by systemd,
launchd, or Task Scheduler and is the only runtime writer of durable service state. Server children
request updates over inherited IPC and never rewrite their service definition. Foreground CLI
processes do not self-update.

Remote updates replace only the server child, not the launcher, so every existing background service
lags behind after a launcher-protocol bump. Keep new server runtimes compatible with the previous
launcher protocol unless impossible, and validate protocol compatibility during preflight.

Installations use exact versions and stage/preflight before publishing an immutable runtime so
restarts never depend on npm cache eviction or a moving tag.

## Commit boundary and database rollback

1. Record the pending update durably (atomic rename + fsync) before stopping the old child.
2. Refuse the update if a database snapshot will not fit on disk. After the old child exits, snapshot
   SQLite (main, WAL, SHM) once per update so failed trial migrations are reversible without down
   migrations. Never overwrite that snapshot on retry. Files outside SQLite (such as attachments)
   are outside this rollback boundary.
3. Start the new runtime as a trial. It must finish migrations, acquire fallible dependencies, bind
   HTTP, and hold long-running roots at the activation gate before reporting `prepared`.
4. Only after the launcher commits the new version durably and replies `committed` may the child
   release activation gates and accept work. A failed or timed-out trial stops and restores the
   snapshot before booting the old version.

## Every database, not just `state.sqlite` (T3o)

<!-- T3o: the fork keeps board data in its own `boards.sqlite`, so the launcher's snapshot covers every database (launcher protocol 4). -->

In T3o the launcher snapshots **every `*.sqlite` file in the state directory**, along with each
one's `-wal` and `-shm` sidecars. The set is discovered from disk rather than named, so a database
added later is covered without the launcher having to know what it is for — today that means
`state.sqlite` and t3o's `boards.sqlite`.

When the filesystem cannot clone, the launcher's online backup copies the primary's main file while the
old child still runs, under a held read snapshot, then its WAL once the child exits; no `-shm` is
taken. Every other database is copied only after the child has exited, in the same per-database
layout. If the online path fails, the offline snapshot runs instead.

Restoring covers the union of what was backed up and what is live. A database the trial update
_created_ has no snapshot entry and is **deleted** on restore, because leaving it would let the
reverted build read a database from the future — migrated by the newer version, with a migration
ledger claiming it is current, so nothing re-runs to reconcile it.

Because snapshots are durable across launcher restarts, a restore can meet a directory written by an
older launcher, whose layout was a single database stored as `database` / `database-wal` /
`database-shm`. That layout is recognised and mapped to the primary database — and under it the
deletion rule above does **not** apply: only the primary is restored, and every other database is
left exactly as it is. A legacy snapshot proves the launcher that wrote it was old, not that the
server was; it says nothing about `boards.sqlite`, which may hold the only copy of the board data.
Only the current layout can claim to know the full pre-update set.

A directory matching _neither_ layout makes the restore **refuse loudly** rather than proceed: a
restore that recognises nothing would otherwise delete the databases and restore nothing. Failing is
recoverable by hand; deleting is not.

The protocol version is part of the safety boundary. Protocol 3 is the version that snapshots every
database in the state directory; a server keeping data in more than one file must not be trialled
under an older launcher, which would snapshot only `state.sqlite` and leave the rest migrated
forward after a rollback.

## Client acknowledgement

An accepted update RPC is only pending. Clients correlate the launcher's update ID with the
reconnected ready state to distinguish commit from rollback. Desktop updates use a two-phase handoff
(prepare token while connected, commit after receiving it) because installing stops the bundled
backend.

## Recovering interrupted threads

- On startup, retire effects tied to the lost process before admitting new work.
- Persist restart-continuation intent in the durable outbox and wait for activation before running
  it so slow providers never delay readiness or the launcher's commit boundary.
- Cap consecutive crash recoveries per unfinished turn so a crashing turn cannot loop forever.
- Never auto-continue a turn that is archived, settled, snoozed, user-stopped, or waiting on a
  blocking user action (approval, question, or secret).
