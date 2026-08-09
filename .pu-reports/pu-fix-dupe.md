# fix-dupe — the algebra must refuse what the database refuses

**Finding closed:** `bind` and `create` both accepted a `chat` target already bound to another node, while `UNIQUE (targetId) WHERE targetKind = 'chat'` refuses it in the table. The client would apply optimistically and then receive a raw unique-constraint violation rather than a typed rejection — the model knowing something is impossible but only learning it from Postgres.

**Changes**
- `workspace-node-algebra.ts` — new `target_already_shown`, refused by both `bind` and `create`. Deliberately NOT overloaded onto `already_bound`, which means "this node already has a target" and is a different fault with a different fix.
- `workspace-node-validate.ts` — new `duplicate_chat_target`, so the same invariant holds at the gate every write path runs, not only at the two entry points.

**Scope of the rule — chat only.** Pages are excluded: opening one page in two panes is legitimate and the table permits it. Terminals are excluded too, because the constraint is chat-scoped and an algebra stricter than its storage becomes an invisible second rule that drifts.

**Detached nodes count as "shown".** A parked node is still a workspace member and the DB constraint does not consult `parentId`.

**Verification:** 460 tests pass across `src/agent-workspaces`.

Report committed per the epic convention: findings that live only in a transcript are lost, as two earlier reviews demonstrated.
