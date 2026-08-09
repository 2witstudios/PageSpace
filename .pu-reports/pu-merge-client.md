# pu-merge-client — integrating the client cluster with the runtime cluster

Two clusters were built in parallel from one base and both touched `apps/web`. 8 conflict regions across 5 files. Resolved by the merge agent; committed by the orchestrator, which found the resolution complete (0 unresolved, 0 markers, all staged) but uncommitted.

## The region that mattered

`workspace-node-runtime.ts`, the write's transaction body. Both sides were required, not one:

- **runtime** wrapped it in a `.catch()` converting `NodeWriteRefused` back to an ordinary refusal — the **ghost guard**. A refusal raised after `within` wrote cannot *return*, because returning commits `within`'s rows without the node that makes them a member. It throws, the transaction unwinds, and the answer is re-formed outside.
- **client** read `ownerId` inside that same transaction, because it already holds the workspace's advisory lock; reading it after release would be a second query on the hot path.

Merged result does both: `ownerId` read inside the transaction and returned in the success shape, `.catch()` outside the body. The comment now states why folding the catch into a `try` inside the body would commit the exact ghost.

## Verified, not assumed

| Guarantee | Result |
|---|---|
| ghost guard — a refused node write leaves no conversation row | ✔ runtime's tests pass unchanged |
| broadcast reaches the owner's sessions room | ✔ client's `ownerId` tests pass unchanged |
| a detached node still renders (#2373) | ✔ sidebar suite green |
| `targets[]` carries `agentPageId` via the shared `conversationPageId` | ✔ present |

**No test from either side was changed to make the merge pass.**

## Gates

`@pagespace/lib` typecheck 0 · `test -- src/agent-workspaces` **682 passed / 21 files** · web `left-sidebar` **94 passed / 6 files** · web `stores/agent-workspace` **90 passed / 4 files**.
