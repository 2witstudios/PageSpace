/**
 * Agent sessions — schema-level proof of the invariants the rest of the system
 * is allowed to assume. These run without a database: they assert the Drizzle
 * declarations the migrations were generated from, plus the reclaim trigger's
 * SQL.
 *
 * The five that must never silently regress:
 *
 *  - **A session is NOT a conversation** — `id` is the session's OWN primary
 *    key, and no conversation-derived column exists on the table. The first cut
 *    had `conversationId` as the PK (one environment per chat thread), which
 *    made shared working contexts structurally impossible; a session is a
 *    drive-level workspace hosting MANY conversations.
 *  - **Threads bind permanently and survive their session** —
 *    `conversations.workspaceId` is a nullable FK with ON DELETE SET NULL: ending
 *    a session keeps its threads as plain history, and a thread's filesystem is
 *    never retroactively rewritten (moving a thread is a fork, not a rebind).
 *  - **Ids address, names label** — a session's `name` carries NO uniqueness of
 *    any kind (renaming can never break a connection); a shell's `(workspaceId,
 *    name)` uniqueness exists for tab titles, while `id` alone is the address.
 *  - **The session owns the sandbox, not the shell** — `agent_workspace_shells`
 *    has no Sprite and no storage columns. If someone adds one, every shell in a
 *    session stops sharing one filesystem and the model is back to the
 *    per-terminal Sprite this design replaced.
 *  - **A Sprite pointer outlives its row** — every delete path into
 *    `agent_workspaces` cascades (drive, owner), so an AFTER DELETE trigger must
 *    rescue `sandboxId`/`spriteInstanceId` into `machine_sprite_reclaims` or a
 *    live VM bills forever with nothing pointing at it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { getTableColumns } from 'drizzle-orm';
import {
  agentWorkspaces,
  agentWorkspaceShells,
  agentWorkspacesRelations,
  agentWorkspaceShellsRelations,
} from '../agent-workspaces';
import { conversations } from '../conversations';

const sessionsConfig = getTableConfig(agentWorkspaces);
const sessionsColumns = getTableColumns(agentWorkspaces);
const shellsConfig = getTableConfig(agentWorkspaceShells);
const shellsColumns = getTableColumns(agentWorkspaceShells);

function fkOnColumn(config: ReturnType<typeof getTableConfig>, columnName: string) {
  const fk = config.foreignKeys.find((candidate) =>
    candidate.reference().columns.some((column) => column.name === columnName)
  );
  expect(fk, `expected a foreign key on ${columnName}`).toBeDefined();
  return fk!;
}

// 0238, not 0233: the un-conflation's DROP TABLE (0236) took 0233's trigger
// with it, so the LIVE trigger is the one 0238 re-armed on the rebuilt table.
const TRIGGER_MIGRATION = path.resolve(
  __dirname,
  '../../../drizzle/0238_session_unconflate_recreate_reclaim_trigger.sql',
);

/** SQL with line comments stripped, so assertions never match prose. */
function stripComments(raw: string): string {
  return raw
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

const triggerSql = stripComments(readFileSync(TRIGGER_MIGRATION, 'utf8'));

describe('agent_workspaces schema — identity', () => {
  it('given a session is NOT a conversation, the session should own its OWN primary key', () => {
    expect(sessionsConfig.name).toBe('agent_workspaces');
    expect(sessionsColumns.id.primary).toBe(true);
    expect(sessionsConfig.primaryKeys).toHaveLength(0);
  });

  it('should carry NO conversation-derived column — the conflation must not creep back', () => {
    // `conversationId` as the PK is what forced one environment per chat
    // thread and made panes unable to share a sandbox. The association runs
    // the OTHER way now: conversations.workspaceId FKs here.
    expect('conversationId' in sessionsColumns).toBe(false);
    expect('agentPageId' in sessionsColumns).toBe(false);
  });

  it('given a session is a drive-level workspace, driveId should be a nullable cascade FK (null = global-assistant, user-scoped)', () => {
    const fk = fkOnColumn(sessionsConfig, 'driveId');
    expect(getTableConfig(fk.reference().foreignTable).name).toBe('drives');
    expect(fk.onDelete).toBe('cascade');
    expect(sessionsColumns.driveId.notNull).toBe(false);
  });

  it('cascade-deletes the session when its owner is deleted', () => {
    const fk = fkOnColumn(sessionsConfig, 'ownerId');
    expect(getTableConfig(fk.reference().foreignTable).name).toBe('users');
    expect(fk.onDelete).toBe('cascade');
    expect(sessionsColumns.ownerId.notNull).toBe(true);
  });

  it('given names label and never address, the session name should carry no uniqueness at all', () => {
    expect(sessionsColumns.name.notNull).toBe(false);
    expect(sessionsColumns.name.isUnique).toBeFalsy();
    const nameIndexes = sessionsConfig.indexes.filter((index) =>
      index.config.columns.some((column) => 'name' in column && column.name === 'name')
    );
    expect(nameIndexes).toHaveLength(0);
    expect(sessionsConfig.uniqueConstraints).toHaveLength(0);
  });

  it('indexes the two lookup keys — driveId and ownerId', () => {
    const indexNames = sessionsConfig.indexes.map((index) => index.config.name);
    expect(indexNames).toContain('agent_workspaces_drive_id_idx');
    expect(indexNames).toContain('agent_workspaces_owner_id_idx');
  });
});

describe('conversations.workspaceId — the thread→session binding', () => {
  const conversationsConfig = getTableConfig(conversations);
  const conversationsColumns = getTableColumns(conversations);

  it('should be a nullable FK onto agent_workspaces.id — plain chats have no session', () => {
    const fk = fkOnColumn(conversationsConfig, 'workspaceId');
    expect(getTableConfig(fk.reference().foreignTable).name).toBe('agent_workspaces');
    expect(fk.reference().foreignColumns.map((column) => column.name)).toEqual(['id']);
    expect(conversationsColumns.workspaceId.notNull).toBe(false);
  });

  it('given threads outlive their session as history, should SET NULL rather than cascade', () => {
    // Cascade here would make ending a session DELETE its chat threads.
    // A session's death releases compute; it must never erase history.
    const fk = fkOnColumn(conversationsConfig, 'workspaceId');
    expect(fk.onDelete).toBe('set null');
  });

  it('indexes workspaceId for the per-session conversation list', () => {
    const indexNames = conversationsConfig.indexes.map((index) => index.config.name);
    expect(indexNames).toContain('conversations_workspace_id_idx');
  });
});

describe('agent_workspaces schema — Sprite identity and storage', () => {
  it.each([
    'spriteKey',
    'sandboxId',
    'spriteInstanceId',
    'egressPolicyToken',
    'teardownRequestedAt',
    'spriteTornDownAt',
  ])('given a session exists before (and possibly without) a Sprite, %s should be nullable', (columnName) => {
    const column = sessionsColumns[columnName as keyof typeof sessionsColumns];
    expect(column, `expected an ${columnName} column`).toBeDefined();
    expect(column.notNull).toBe(false);
  });

  it('given the sprite key is never a lookup address, spriteKey should not be unique', () => {
    expect(sessionsColumns.spriteKey.isUnique).toBeFalsy();
  });

  it('given billing must never run retroactively, storageLastBilledAt should default to now() and be NOT NULL', () => {
    expect(sessionsColumns.storageLastBilledAt.notNull).toBe(true);
    expect(sessionsColumns.storageLastBilledAt.hasDefault).toBe(true);
  });

  it('given "never measured" must be distinguishable from zero, the measurement columns should be nullable', () => {
    expect(sessionsColumns.storageMeasuredBytes.notNull).toBe(false);
    expect(sessionsColumns.storageMeasuredBytes.columnType).toBe('PgBigInt53');
    expect(sessionsColumns.storageMeasuredAt.notNull).toBe(false);
  });

  it('given a killed session keeps its row, lastActiveAt and endedAt should be nullable stamps', () => {
    expect(sessionsColumns.lastActiveAt.notNull).toBe(false);
    expect(sessionsColumns.endedAt.notNull).toBe(false);
    expect(sessionsColumns.createdAt.notNull).toBe(true);
    expect(sessionsColumns.createdAt.hasDefault).toBe(true);
    expect(sessionsColumns.updatedAt.notNull).toBe(true);
  });
});

describe('agent_workspace_shells schema', () => {
  it('cascade-deletes shells when their session row dies, addressing the session by its own id', () => {
    expect(shellsConfig.name).toBe('agent_workspace_shells');
    const fk = fkOnColumn(shellsConfig, 'workspaceId');
    expect(getTableConfig(fk.reference().foreignTable).name).toBe('agent_workspaces');
    expect(fk.reference().foreignColumns.map((column) => column.name)).toEqual(['id']);
    expect(fk.onDelete).toBe('cascade');
  });

  it('cascade-deletes shells when their owner is deleted', () => {
    const fk = fkOnColumn(shellsConfig, 'ownerId');
    expect(getTableConfig(fk.reference().foreignTable).name).toBe('users');
    expect(fk.onDelete).toBe('cascade');
  });

  it('given shellId is the whole wire address, id should be the sole primary key', () => {
    expect(shellsColumns.id.primary).toBe(true);
    expect(shellsConfig.primaryKeys).toHaveLength(0);
  });

  it('given tab titles must be unambiguous, (workspaceId, name) should be unique — per session, never globally', () => {
    const unique = shellsConfig.indexes.find(
      (index) => index.config.name === 'agent_workspace_shells_workspace_name_idx'
    );
    expect(unique).toBeDefined();
    expect(unique!.config.unique).toBe(true);
    expect(unique!.config.columns.map((column) => ('name' in column ? column.name : null))).toEqual([
      'workspaceId',
      'name',
    ]);
    expect(shellsColumns.name.isUnique).toBeFalsy();
  });

  it('indexes workspaceId for the per-session shell list', () => {
    const indexNames = shellsConfig.indexes.map((index) => index.config.name);
    expect(indexNames).toContain('agent_workspace_shells_workspace_id_idx');
  });

  it('given the SESSION owns the sandbox, a shell should carry NO Sprite or storage columns', () => {
    const forbidden = [
      'spriteKey',
      'sandboxId',
      'spriteInstanceId',
      'egressPolicyToken',
      'teardownRequestedAt',
      'spriteTornDownAt',
      'storageLastBilledAt',
      'storageMeasuredBytes',
      'storageMeasuredAt',
    ];
    for (const columnName of forbidden) {
      expect(columnName in shellsColumns, `${columnName} must not exist on agent_workspace_shells`).toBe(false);
    }
  });

  it('given a PTY row can predate its first connect, command and spriteExecId should be nullable', () => {
    expect(shellsColumns.name.notNull).toBe(true);
    expect(shellsColumns.agentType.notNull).toBe(true);
    expect(shellsColumns.command.notNull).toBe(false);
    expect(shellsColumns.spriteExecId.notNull).toBe(false);
  });

  it('given an over-large burst leaves an empty tail, coldTailHasOutput should be a NOT NULL flag defaulting to false', () => {
    expect(shellsColumns.coldTail.notNull).toBe(false);
    expect(shellsColumns.coldTailAt.notNull).toBe(false);
    expect(shellsColumns.coldTailHasOutput.notNull).toBe(true);
    expect(shellsColumns.coldTailHasOutput.hasDefault).toBe(true);
    expect(shellsColumns.coldTailHasOutput.default).toBe(false);
  });
});

describe('agent sessions relations', () => {
  it('exports both tables relations, wiring a session to its shells', () => {
    expect(agentWorkspacesRelations).toBeDefined();
    expect(agentWorkspaceShellsRelations).toBeDefined();
  });
});

/**
 * 0238 is APPLIED HISTORY and its text is frozen: it still says
 * `agent_sessions`, because that is what the table was called when it ran.
 * 0254 renames the table, the trigger and the function in place — that the
 * trigger SURVIVES the rename and still fires on `agent_workspaces` is asserted
 * against a live database in
 * `src/__tests__/agent-workspaces-rename-migration.test.ts`, which is the only
 * place that can prove it.
 */
describe('agent_workspaces sprite reclaim trigger (0238, pre-rename text)', () => {
  it('fires AFTER DELETE, per row, on the table as 0238 named it', () => {
    expect(triggerSql).toMatch(/CREATE TRIGGER agent_sessions_sprite_reclaim/);
    expect(triggerSql).toMatch(/AFTER DELETE ON agent_sessions/);
    expect(triggerSql).toMatch(/FOR EACH ROW/);
    expect(triggerSql).toMatch(/EXECUTE FUNCTION agent_sessions_capture_sprite_reclaim\(\)/);
  });

  it('given an erasure must never be blocked by a missing grant, the function should be SECURITY DEFINER with a pinned search_path', () => {
    expect(triggerSql).toMatch(/SECURITY DEFINER/);
    expect(triggerSql).toMatch(/SET search_path = public/);
  });

  it('rescues both pointer halves into machine_sprite_reclaims', () => {
    expect(triggerSql).toMatch(
      /INSERT INTO public\.machine_sprite_reclaims \("sandboxId", "spriteInstanceId"\)/
    );
    expect(triggerSql).toMatch(/VALUES \(OLD\."sandboxId", OLD\."spriteInstanceId"\)/);
    expect(triggerSql).toMatch(/ON CONFLICT \("sandboxId"\) DO UPDATE/);
  });

  it('given a reused Sprite NAME can address a replacement VM, skips unprovisioned and already-torn-down rows', () => {
    expect(triggerSql).toMatch(/OLD\."sandboxId" IS NOT NULL AND OLD\."spriteTornDownAt" IS NULL/);
  });

  it('given a shell has no Sprite pointer, defines no trigger on agent_workspace_shells', () => {
    expect(triggerSql).not.toMatch(/ON agent_workspace_shells/);
  });
});
