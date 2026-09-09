/**
 * `UNIQUE (targetId) WHERE targetKind = 'chat'` — and the write order a PARTIAL
 * UNIQUE INDEX forces on anything that moves a conversation between nodes.
 *
 * The index states the model's one global rule: a conversation is shown by at
 * most one node, anywhere. What it does NOT do is wait until the end of a
 * statement to say so. A unique index is checked as each row is written, so a
 * single multi-row upsert can be rejected for a state that exists only *between*
 * two of its own rows — a state the tree being asked for never contains.
 *
 * That is not a hypothetical. `writeWorkspaceNodes` issues one multi-row upsert
 * on purpose, because Postgres DOES defer foreign keys to end of statement and
 * a validated tree should not have to be topologically sorted before it can be
 * stored. Deletes are issued first, which frees any conversation held by a node
 * the write removes. But a write that hands a conversation from one node to
 * another while KEEPING BOTH has an empty `drop` — nothing is freed, the upsert
 * is the only statement, and the row order inside it decides whether a valid
 * write succeeds. A SWAP has no row order that works at all.
 *
 * So these tests pin the index's actual behaviour rather than its intent, and
 * they run against real Postgres because that behaviour is the whole subject:
 * no fake reproduces "rejected halfway through a statement I would have
 * accepted the end of". They fail loudly without a database rather than
 * skipping — a silently skipped constraint test proves nothing, which is the
 * failure mode this file exists to catch.
 *
 * Found in review of PR #2378 (CodeRabbit), narrowed with it to surviving-node
 * reassignment and swaps.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Client } from 'pg';

const WS = 'wsnodeidx';
const OWNER = 'usernodeidx';

/** The upsert `writeWorkspaceNodes` issues, verbatim in shape. */
const UPSERT = `
  INSERT INTO agent_workspace_nodes
    ("rootId", id, "parentId", position, "nodeType", "targetKind", "targetId", "createdAt", "updatedAt")
  VALUES ($1, $2, $3, $4, 'pane', $5, $6, now(), now()),
         ($1, $7, $8, $9, 'pane', $10, $11, now(), now())
  ON CONFLICT ("rootId", id) DO UPDATE
    SET "targetKind" = excluded."targetKind", "targetId" = excluded."targetId"
`;

/** The release the store now performs first. Chat only — the index covers nothing else. */
const RELEASE = `
  UPDATE agent_workspace_nodes SET "targetKind" = NULL, "targetId" = NULL
   WHERE "rootId" = $1 AND id = ANY($2) AND "targetKind" = 'chat'
`;

describe('agent_workspace_nodes chat-target index — moving a conversation between surviving nodes', () => {
  const url = process.env.DATABASE_URL;
  let client: Client;

  beforeAll(async () => {
    if (!url) {
      throw new Error(
        'agent-workspace-nodes-chat-index.test.ts requires DATABASE_URL pointed at a migrated ' +
          'database. It is not skippable: the subject is a partial unique index\'s mid-statement behaviour, ' +
          'which only real Postgres exhibits, and a silent skip would report a green pass that proves nothing.',
      );
    }
    client = new Client({ connectionString: url });
    await client.connect();
  });

  afterAll(async () => {
    if (client) {
      await client.query(`DELETE FROM users WHERE id = $1`, [OWNER]).catch(() => undefined);
      await client.end();
    }
  });

  beforeEach(async () => {
    // Rebuilt per test rather than shared: each one commits nothing, but a
    // failing assertion should never leave the next test reading a tree it did
    // not build.
    await client.query(`DELETE FROM users WHERE id = $1`, [OWNER]);
    await client.query(
      `INSERT INTO users (id, name, email, "emailBidx", provider, "tokenVersion", role, "createdAt", "updatedAt")
       VALUES ($1, 'Node Index', 'node-index@example.test', 'bidx-node-index', 'email', 0, 'user', now(), now())`,
      [OWNER],
    );
    await client.query(
      `INSERT INTO agent_workspaces (id, "ownerId", name, "createdAt", "updatedAt")
       VALUES ($1, $2, 'node index', now(), now())`,
      [WS, OWNER],
    );
    await client.query(
      `INSERT INTO agent_workspace_nodes
         ("rootId", id, "parentId", position, "nodeType", "axis", "targetKind", "targetId", "createdAt", "updatedAt")
       VALUES ($1, 'root', NULL, 0, 'root', 'row', NULL, NULL, now(), now()),
              ($1, 'n1', 'root', 0, 'pane', NULL, 'chat', 'conv-c', now(), now()),
              ($1, 'n2', 'root', 1, 'pane', NULL, 'chat', 'conv-d', now(), now())`,
      [WS],
    );
  });

  it('REJECTS a swap when the upsert runs alone — the failure the release exists to prevent', async () => {
    // n1: conv-c → conv-d, n2: conv-d → conv-c. Both nodes survive, so a store
    // that only deletes-then-upserts has nothing to delete. Whichever row the
    // statement writes first collides with the other's untouched binding.
    await expect(
      client.query(UPSERT, [WS, 'n1', 'root', 0, 'chat', 'conv-d', 'n2', 'root', 1, 'chat', 'conv-c']),
    ).rejects.toThrow(/agent_workspace_nodes_chat_target_idx/);
  });

  it('ACCEPTS the same swap when the bindings are released first', async () => {
    await client.query(RELEASE, [WS, ['n1', 'n2']]);
    await client.query(UPSERT, [WS, 'n1', 'root', 0, 'chat', 'conv-d', 'n2', 'root', 1, 'chat', 'conv-c']);

    const { rows } = await client.query<{ id: string; targetId: string }>(
      `SELECT id, "targetId" FROM agent_workspace_nodes
        WHERE "rootId" = $1 AND "targetKind" = 'chat' ORDER BY id`,
      [WS],
    );
    expect(rows).toEqual([
      { id: 'n1', targetId: 'conv-d' },
      { id: 'n2', targetId: 'conv-c' },
    ]);
  });

  it('ACCEPTS a hand-off to a node that survives unbound', async () => {
    // The simpler half of the same shape: n2 gives up its conversation and n1
    // takes it. Still no delete, so still nothing freed without the release.
    await client.query(RELEASE, [WS, ['n1', 'n2']]);
    await client.query(UPSERT, [WS, 'n1', 'root', 0, 'chat', 'conv-d', 'n2', 'root', 1, null, null]);

    const { rows } = await client.query<{ id: string; targetId: string | null }>(
      `SELECT id, "targetId" FROM agent_workspace_nodes
        WHERE "rootId" = $1 AND id IN ('n1','n2') ORDER BY id`,
      [WS],
    );
    expect(rows).toEqual([
      { id: 'n1', targetId: 'conv-d' },
      { id: 'n2', targetId: null },
    ]);
  });

  it('STILL REJECTS a genuine duplicate — the release does not weaken the rule', async () => {
    // The mutation check on the fix. Releasing first must not turn the index
    // into a formality: two nodes asking for one conversation is the thing it
    // exists to refuse, and it refuses it whether or not they were released.
    await client.query(RELEASE, [WS, ['n1', 'n2']]);
    await expect(
      client.query(UPSERT, [WS, 'n1', 'root', 0, 'chat', 'conv-c', 'n2', 'root', 1, 'chat', 'conv-c']),
    ).rejects.toThrow(/agent_workspace_nodes_chat_target_idx/);
  });

  it('STILL REJECTS taking a conversation the write did not name', async () => {
    // The release only clears rows the write is about to restate, so a node it
    // never mentions keeps its binding — and a write reaching for that
    // conversation is a real duplicate in the tree it asks for, which
    // `validateTree` refuses upstream and the index refuses here.
    await client.query(
      `INSERT INTO agent_workspace_nodes
         ("rootId", id, "parentId", position, "nodeType", "targetKind", "targetId", "createdAt", "updatedAt")
       VALUES ($1, 'n3', 'root', 2, 'pane', 'chat', 'conv-e', now(), now())`,
      [WS],
    );
    await client.query(RELEASE, [WS, ['n1', 'n2']]);
    await expect(
      client.query(UPSERT, [WS, 'n1', 'root', 0, 'chat', 'conv-e', 'n2', 'root', 1, null, null]),
    ).rejects.toThrow(/agent_workspace_nodes_chat_target_idx/);
  });
});
