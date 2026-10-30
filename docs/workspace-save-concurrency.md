# Workspace save concurrency

An owner tab may autosave a snapshot loaded before a host command or another tab changed the
workspace. Replacing the host's content with that snapshot loses the other writer's nodes, titles,
geometry or board edits. Workspace saves now apply only the changes since that owner's baseline
to a fresh host read, inside the existing workspace write queue.

## Owner snapshots and command writes

`workspace:load` records a private baseline for an owner connection. `workspace:save` keeps its
existing public arguments; `CorePlatform.handleWithSender` supplies the connection identity. The
client cannot choose another connection's baseline. A relay peer's load creates no owner baseline,
and relay policy continues to refuse its workspace saves.

The queued save reads its baseline when its turn starts. After successful persistence it advances
that baseline to the submitted snapshot before the next queued save starts. Two overlapping saves
from one tab therefore see that tab's preceding submitted changes. Disconnect discards the
baseline, and a queued save from before a disconnect or new load is refused. A late save cannot
recreate the baseline. Legacy initialization without a successful owner
load retains the existing empty-workspace and pending-adoption guards.

`CanvasContentWriter` uses `WorkspaceStore.saveChanges` to rebase an existing command snapshot and
`updateWorkspace` for patches that must inspect state inside the write queue. A patch claiming a
launch is checked against that fresh node; a deletion queued ahead of it cannot be resurrected.
Read, modify and write use the same queue as browser saves and content-authority flushes.

## Merge rules

- Untouched node and project fields retain the host value. Changed fields are atomic: a requested
  position replaces that position, while an independent title or pending-launch claim survives.
- Items added by another writer remain present. A stale edit cannot resurrect an item deleted
  since its baseline; explicit deletion of an item the writer knew remains a deletion.
- A writer's explicit reorder applies to existing items. Otherwise host ordering is preserved,
  and new items are inserted relative to their requested surviving neighbor.
- Boards use the existing kanban operation diff and reducer, preserving unrelated metadata and
  ranked assignments. Edge lists preserve independent additions and remove references to nodes
  deleted by the merged save.
- Conflicting creations of the same ID and edits to an unreadable project are refused with a
  named error. A drag expressed in an obsolete parent coordinate frame is also refused rather
  than interpreted in the new frame. The original file and caller baseline remain recoverable.

For a governed project, the existing canvas authority still decides content from ordered ops.
An owner tab's content and execution overlay follow the established overlay path because its
content ops already travelled through the reflector. A host command instead rebases its own
unpublished changes and publishes only that resulting diff before the overlay save. Neither path
creates a competing authority or new execution grants.

## Persistence and recovery

Delta writes report failed folder or app-data writes instead of acknowledging an edit that did
not reach its file. A failed owner save does not advance its baseline, so the same submitted
changes can be recovered after the storage problem is fixed. A command must not start a session
on the strength of a rejected write.

Publishing a reflected op and writing disk are separate effects. A failure after publication
may leave an uncertain result; the existing authority retry state and request ledger govern
recovery. This mechanism does not provide a cross-process filesystem transaction or exactly-once
execution across disk, Git and terminal input. Existing limits on external edits racing an atomic
write still apply.

The direct `WorkspaceStore.save` API retains its existing semantics for migration and callers
that deliberately provide a complete authoritative workspace. New concurrent host commands use
the delta or queued-edit surface instead.

Behavior is covered by `workspace-store.concurrency.test.ts`, `workspace-save-merge.test.ts`,
`canvas-content-writer.test.ts` and the real-authority and delayed-launch cases in
`server/headless-node-factory.test.ts`.
