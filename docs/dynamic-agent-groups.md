# Dynamic agent groups — v1

The `groups` control verb manages visual frames, membership and durable space reservations through
the host workspace writer. It does not grant execution or ownership authority.

## Public control contract

`groups --spec '<json>' [--dry-run] [--request-id <id>]` applies a declarative visual batch to
the caller's project. `groups --get` reads its visible groups and reservations. The existing
verified-node, creator/project scope and capability gates remain mandatory. Desktop uses the
same host planner; no renderer-only execution or account permissions are introduced.

```json
{
  "version": 1,
  "groups": [
    {"id": "group-api", "title": "API", "parent": null},
    {"id": "group-tests", "title": "Tests", "parent": "group-api"}
  ],
  "members": [{"id": "term-existing", "group": "group-api"}],
  "reserve": [{"id": "slot-review", "group": "group-tests", "width": 640, "height": 440}],
  "release": [],
  "remove": []
}
```

IDs are stable explicit identities, not names or ownership claims. Repeating the same desired
batch converges without duplicate frames or reservations; request retry/replay uses the existing
control request ledger, including uncertain outcomes. After restart persisted metadata is still
data: current process-local ownership or explicit operator project scope is required. A reservation
never grants permission to launch or control a session.

Arrays omitted from a spec make no declaration about those operations. `parent` omitted on an
existing group preserves its current parent; `null` explicitly places it at the project root.
All referenced IDs must exist in the current project or be frames declared in the same batch.
Group IDs must be unique across the whole workspace. Unknown schema fields are refused.

Groups may be created, updated or nested; members name existing terminals/groups. Removal requires
an explicit promotion destination and removes only visual frames. It never closes sessions or
deletes files/worktrees. Crossing execution/worktree inheritance or removing a bound worktree
frame refuses and uses the existing domain path instead. Links between surviving nodes remain.

Reservations are persisted group metadata, with stable IDs, size and relative position. They are
visible in group UI and the read reply. `open-agent/open-terminal --group <id> --reservation <id>`
consumes one matching slot for a single new node inside the same canonical workspace transaction.
Normal unreserved opens allocate around actual children and reservations with the same planner.
Restored reservations do not restore creator/launch authority or execute anything at boot.

For example, to reserve and then open a plain terminal:

```sh
sh /data/canvas-control/nodeterm.sh groups --spec '{"version":1,"groups":[{"id":"review","title":"Review"}],"reserve":[{"id":"review-1","group":"review","width":800,"height":600}]}' --dry-run
sh /data/canvas-control/nodeterm.sh groups --spec '{"version":1,"groups":[{"id":"review","title":"Review"}],"reserve":[{"id":"review-1","group":"review","width":800,"height":600}]}' --request-id review-layout-unique-1
sh /data/canvas-control/nodeterm.sh open-terminal --group review --reservation review-1 --request-id review-terminal-unique-1
sh /data/canvas-control/nodeterm.sh groups --get
```

Choose fresh request IDs for new intentions; reuse the exact ID and arguments only when retrying
the same lost reply. `groups --get` always reads current facts, even with an explicit request ID;
it never returns a cached creation-ledger reply. A read is scoped to frames the caller can mutate.
Slot identity is local to its frame. Consumption persists `state: "consumed"` and the actual node ID;
release persists `state: "released"`. Reapplying `reserve` never rearms either tombstone. Use a new
slot ID for new work. A failed launch after persistence retains the node and consumed slot for
inspection; it does not free space for an automatic duplicate launch.

Release unused active slots before retiring a frame. To retire a frame without closing its terminals:

```sh
sh /data/canvas-control/nodeterm.sh groups --spec '{"version":1,"release":[{"id":"review-1","group":"review"}]}'
sh /data/canvas-control/nodeterm.sh groups --spec '{"version":1,"remove":[{"id":"review","promoteTo":null}]}'
```

## Planning, storage and geometry

The shared module validates the whole bounded schema and the full scene, plans a detached result,
and returns explicit affected IDs. The host validates every explicit reference and all indirect
footprint changes, including descendants of moved frames, before one writer/FIFO edit publishes
and persists the batch. A refusal leaves no membership, group or reservation changes. Dry runs
plan and authorize the identical transformation without publishing/saving. New frames are recorded
in the process-local creator ledger only after persistence succeeds.

Use existing group padding/header, actual measured or stored sizes, group minimums and canvas
limits. Preserve valid positions and manually enlarged frames. Place new members/reservations in
deterministic free rectangles; do not count children to infer slots. Grow frames and their ancestors
without shrinking on deletion. Reconcile changed sibling footprints against all static obstacles;
never silently move an unauthorized obstacle. Only affected collision-free results are accepted;
unrelated pre-existing collisions are not an instruction to rearrange the whole canvas.

Desktop gesture completion and normal grouped opens share this reconciliation. No camera, focus,
active project, PTY, conversation, cwd or agent-state update is part of a visual batch. Atomicity is
the existing canonical workspace transaction, not a new persistence store or request ledger.

Existing `resize`, `place`, `arrange`, `align`, `move` and `ungroup` controls reconcile managed
subtrees through the same planner. Managed host geometry publishes atomically and reports its
final adjusted layout. Legacy `ungroup` and agent `close` also refuse frames with active slots.
A UI save based on an older scene cannot occupy a newly reserved hole: a conflicting gesture is
refused before persistence with `workspace-save-group-layout-conflict`. Reload before repeating
that gesture. Ordinary compatible edits, including titles, remain valid.

## Acceptance and compatibility

Host replies distinguish `planned`, `applied`, `unchanged`, `current`, `rejected` and
`indeterminate`. Validation, ownership and recipient compatibility are checked before publication.
Once a batch has been published, a lost persistence acknowledgement is indeterminate; inspect the
current scene and reuse the same request ID rather than issuing a new creation intention.
The request ledger retains its existing lifetime; persisted IDs and reservation tombstones provide
declarative convergence, not proof that a previous launch was delivered or that a caller owns it.

Every connected broadcast client must advertise a mounted atomic batch receiver. An old client
causes a named refusal before any change; reconnect it with an updated build. Updated native,
browser and relay clients receive one bounded envelope per batch. Relay subscription grants no
editing rights, and outgoing batches retain existing project scoping and execution-field stripping.
With no clients connected the canonical host writer still applies and persists the batch.

This first version manages available local projects. Desktop grouped POSIX terminal and supported
agent opens use the host allocator; ordinary SSH/custom-agent/Windows opens retain their existing
adapters and shared renderer allocation. Explicit reservation consumption requires the host route;
Windows gives a named refusal. Neither a saved frame nor a reservation waives worktree inheritance,
creator scope or current-run ownership checks. Retirement of a worktree-bound frame is refused.

Resource limits are 256 declarations per spec, 4096 scene nodes, 64 nesting levels, 256 reservation
identities per frame and 4096 across the scene. Consumed/released identities count toward the
reservation budget. Slot sizes use the existing terminal minimum and 2400×1600 maximum; frames
can grow beyond terminal bounds. Oversized publication envelopes are refused as a whole.

Behavior checks cover nested growth/containment, heterogeneous sizes, deterministic holes,
reservation consume/release/restart/concurrency, idempotence, validation and authorization without
partial effects, worktree inheritance refusal, links/session metadata preservation, host overlays,
and real generated CLI against an isolated compiled runtime. Relevant Desktop paths are tested
through shared modules and host routing. Mobile receives ordinary saved canvas data and no new
agent execution API; native companion presentation of reservations is a follow-up.

The connected old Server bundle cannot run this contract until an explicitly coordinated deployment.
The source baseline contains broader unintegrated work; publishing this feature must not silently
deploy the entire baseline as if it were only this patch.
