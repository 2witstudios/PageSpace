/**
 * Drive boxes — schema-level proof of the invariants Phases 2–6 are allowed to
 * assume. These run without a database: they assert the Drizzle declarations
 * the migrations were generated from, plus the reclaim trigger's SQL text.
 *
 * The four that must never silently regress:
 *
 *  - **A Sprite belongs to exactly ONE row.** A box-bound session holds no
 *    Sprite pointer (`agent_workspaces_env_no_sprite_check`) and borrows its
 *    box's. If that CHECK goes, two rows can claim one VM: ending one session
 *    tears down a filesystem other sessions are still using, and both AFTER
 *    DELETE triggers enqueue the same name.
 *  - **There is NO kind taxonomy and NO stored status.** An earlier cut had a
 *    `drive_env_kind` enum plus a CHECK partitioning Sprite pointers by it;
 *    both are gone, because dev/staging/prod are use cases expressed by NAMING
 *    an env. `substrate` is a DIFFERENT axis and was reserved by the founder
 *    (2026-08-18: "onprem later via a local bridge to the user's own shell";
 *    "envs will need a size/class attribute eventually") — what RUNS an env,
 *    which a name cannot say. It carries a `'sprite'` default and a CHECK
 *    that a `'local'` row holds NO Sprite pointer, so every env that carries a
 *    Sprite pointer is still a Sprite env, the Sprite columns stay meaningful
 *    unconditionally, and `machine_sprite_reclaims` is still the only outbox
 *    this table can feed. If a `kind` column reappears here, or `substrate`
 *    loses its default or its CHECK, the use-case taxonomy is creeping back
 *    or a local row can masquerade as a VM.
 *  - **A Sprite pointer outlives its row.** Every delete path into
 *    `drive_envs` cascades (drive delete, permanent drive delete, Art. 17
 *    erasure through the drive), so the AFTER DELETE trigger must rescue
 *    `sandboxId`/`spriteInstanceId` into the outbox or a live VM bills forever
 *    with nothing pointing at it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { getTableColumns } from 'drizzle-orm';
import { driveEnvs, driveEnvsRelations } from '../drive-envs';
import { agentWorkspaces } from '../agent-workspaces';

const envsConfig = getTableConfig(driveEnvs);
const envsColumns = getTableColumns(driveEnvs);
const sessionsConfig = getTableConfig(agentWorkspaces);
const sessionsColumns = getTableColumns(agentWorkspaces);

function fkOnColumn(config: ReturnType<typeof getTableConfig>, columnName: string) {
  const fk = config.foreignKeys.find((candidate) =>
    candidate.reference().columns.some((column) => column.name === columnName)
  );
  expect(fk, `expected a foreign key on ${columnName}`).toBeDefined();
  return fk!;
}

/**
 * A CHECK's predicate flattened to text. The SQL chunks interleave raw string
 * fragments with live column objects (which hold a back-reference to their
 * table, so the whole thing is circular and cannot be JSON-stringified) —
 * reducing each chunk to its `name` is what makes "WHICH columns is this
 * predicate stated over" an assertable question.
 */
function checkSql(config: ReturnType<typeof getTableConfig>, name: string): string {
  const constraint = config.checks.find((candidate) => candidate.name === name);
  expect(constraint, `expected a CHECK named ${name}`).toBeDefined();
  const chunks = (constraint!.value as unknown as { queryChunks: unknown[] }).queryChunks;
  return chunks
    .map((chunk) => {
      if (typeof chunk === 'string') return chunk;
      const named = chunk as { name?: unknown; value?: unknown };
      if (typeof named.name === 'string') return named.name;
      if (Array.isArray(named.value)) return named.value.join('');
      return '';
    })
    .join(' ');
}

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../drizzle');

/**
 * SQL with `--` comments removed — WHOLE-LINE and TRAILING both, so no
 * assertion can be satisfied or broken by prose.
 *
 * Deliberately NOT `stripSqlComments` from `../../migration-sql-analysis`,
 * which is the shared one: that helper strips whole-line comments ONLY, which
 * is sufficient for the DROP analysis it serves and is NOT sufficient here —
 * a trailing `-- ... INSERT INTO ...` would break the outbox assertion below.
 * Widening the shared helper would change what every DROP-migration test sees,
 * which is not this PR's business. These files are more than half
 * commentary, and the commentary quotes SQL (`INSERT INTO ...`,
 * `ON CONFLICT ...`) precisely because it is explaining it, so a matcher that
 * saw comments would be reading the explanation instead of the statement.
 *
 * A trailing `--` is only treated as a comment when an EVEN number of single
 * quotes precede it on that line, i.e. when it is not inside a string literal.
 * That is a heuristic rather than a parser, and it is the right trade for a
 * test helper: it handles every form these migrations actually use, and the
 * behavioural proof lives in the integration suite regardless.
 */
function stripComments(raw: string): string {
  return raw
    .split('\n')
    .map((line) => {
      const at = line.indexOf('--');
      if (at === -1) return line;
      const quotesBefore = (line.slice(0, at).match(/'/g) ?? []).length;
      return quotesBefore % 2 === 0 ? line.slice(0, at) : line;
    })
    .filter((line) => line.trim().length > 0)
    .join('\n');
}

const triggerSql = stripComments(
  readFileSync(path.join(MIGRATIONS_DIR, '0263_drive_envs_reclaim_trigger.sql'), 'utf8'),
);
const schemaSql = stripComments(
  readFileSync(path.join(MIGRATIONS_DIR, '0262_aspiring_star_brand.sql'), 'utf8'),
);

describe('drive_envs schema — identity and ownership', () => {
  it('given a box is a drive entity and not a page, should key on its own cuid2 with a NOT NULL drive', () => {
    expect(envsConfig.name).toBe('drive_envs');
    expect(envsColumns.id.primary).toBe(true);
    expect(envsColumns.driveId.notNull).toBe(true);
    // No page linkage of any kind — the deleted MACHINE page type must not
    // come back through a column.
    expect('pageId' in envsColumns).toBe(false);
  });

  it('given the drive owns the box, should CASCADE from drives and only SET NULL from the creator', () => {
    expect(fkOnColumn(envsConfig, 'driveId').onDelete).toBe('cascade');
    // `createdBy` is audit only. Cascading it would delete a machine the drive
    // still uses because the person who clicked "create" left.
    expect(fkOnColumn(envsConfig, 'createdBy').onDelete).toBe('set null');
    expect(envsColumns.createdBy.notNull).toBe(false);
  });

  it('given a box is a deliberate deploy target, should make (driveId, name) unique', () => {
    const unique = envsConfig.indexes.find((index) => index.config.name === 'drive_envs_drive_name_idx');
    expect(unique?.config.unique).toBe(true);
    expect(unique?.config.columns.map((column) => (column as { name: string }).name))
      .toEqual(['driveId', 'name']);
    expect(envsColumns.name.notNull).toBe(true);
  });
});

describe('drive_envs schema — derived state, not stored state', () => {
  it('given kinds are names not types, should store NO kind column', () => {
    // The founder decision this table was reshaped around: dev/staging/prod
    // are use cases a user expresses by naming an env. A `kind` column would
    // force every new use case through a migration.
    expect('kind' in envsColumns).toBe(false);
  });

  it('given substrate is the reserved "what runs it" axis, should store it with a sprite default and a CHECK that keeps local rows off the Sprite predicates', () => {
    // This test used to assert `'substrate' in envsColumns === false`, and that
    // was right while every env was Sprite-backed. The Local Environments epic
    // (founder ratification 2026-08-18) reopened exactly and only this axis:
    // a use case is expressible by a name, WHAT RUNS the env is not. The
    // guard now pins the shape that keeps the old corollary true — a local
    // row can never carry a Sprite pointer — rather than the column's absence.
    expect('substrate' in envsColumns).toBe(true);
    expect(envsColumns.substrate.notNull).toBe(true);
    expect(envsColumns.substrate.hasDefault).toBe(true);
    expect(envsConfig.checks.find((check) => check.name === 'drive_envs_local_no_sprite_check')).toBeDefined();
    expect(envsConfig.checks.find((check) => check.name === 'drive_envs_substrate_check')).toBeDefined();
  });

  it('given status is derived from the pointer columns, should store NO status column', () => {
    expect('status' in envsColumns).toBe(false);
  });
});

describe('drive_envs schema — sprite identity mirrors agent_workspaces', () => {
  it('should carry every sprite identity and storage column the session table carries', () => {
    for (const column of [
      'spriteKey', 'sandboxId', 'spriteInstanceId', 'egressPolicyToken',
      'teardownRequestedAt', 'spriteTornDownAt',
      'storageLastBilledAt', 'storageMeasuredBytes', 'storageMeasuredAt',
      'lastActiveAt',
    ]) {
      expect(column in envsColumns, `drive_envs.${column}`).toBe(true);
      expect(column in sessionsColumns, `agent_workspaces.${column}`).toBe(true);
    }
  });

  it('given a box exists before (and possibly without) a Sprite, should leave every pointer nullable', () => {
    for (const column of ['spriteKey', 'sandboxId', 'spriteInstanceId', 'egressPolicyToken'] as const) {
      expect(envsColumns[column].notNull, column).toBe(false);
    }
    // The one storage column that is NOT NULL, for the same reason it is on
    // the session table: a NULL watermark would bill the box retroactively to
    // the epoch on its first reconcile.
    expect(envsColumns.storageLastBilledAt.notNull).toBe(true);
    expect(envsColumns.storageLastBilledAt.hasDefault).toBe(true);
  });

  it('given the storage reconcile reads both row sources, should measure bytes as a JS number bigint', () => {
    expect(envsColumns.storageMeasuredBytes.getSQLType()).toBe('bigint');
    expect(envsColumns.storageMeasuredBytes.getSQLType())
      .toBe(sessionsColumns.storageMeasuredBytes.getSQLType());
  });

  it('given the crons scan "still believed live", should index exactly that partial slice', () => {
    const live = envsConfig.indexes.find((index) => index.config.name === 'drive_envs_live_sprite_idx');
    expect(live).toBeDefined();
    expect(live?.config.unique).toBe(false);
    expect(live?.config.columns.map((column) => (column as { name: string }).name))
      .toEqual(['sandboxId', 'spriteTornDownAt']);
    expect(live?.config.where).toBeDefined();
  });
});

describe('drive_envs schema — the CHECKs on the session side', () => {
  it('given an env-bound session borrows the env sprite, should forbid its own pointers', () => {
    const sql = checkSql(sessionsConfig, 'agent_workspaces_env_no_sprite_check');
    expect(sql).toContain('envId');
    for (const column of ['sandboxId', 'spriteKey', 'spriteInstanceId']) {
      expect(sql, `predicate must mention ${column}`).toContain(column);
    }
  });

  it('given agent_workspaces is populated, should ship its CHECK NOT VALID with the VALIDATE deferred', () => {
    expect(schemaSql).toMatch(
      /ADD CONSTRAINT "agent_workspaces_env_no_sprite_check"[\s\S]*?NOT VALID/,
    );
    // Stage 2 must NOT ride this release: every pending migration runs in one
    // invocation, so a VALIDATE here would execute seconds after the ADD.
    expect(schemaSql).not.toMatch(/VALIDATE CONSTRAINT/);
  });

  it('given a box is drive-owned, should refuse a box-bound session that has no drive', () => {
    const sql = checkSql(sessionsConfig, 'agent_workspaces_env_needs_drive_check');
    expect(sql).toContain('envId');
    expect(sql).toContain('driveId');
    // The other half of drive-agreement — that the box belongs to THIS
    // session's drive — is Phase 3's `spawnAgentSession`, deliberately (see the
    // constraint's docblock). This test is the marker for that follow-up.
    expect(schemaSql).toMatch(
      /ADD CONSTRAINT "agent_workspaces_env_needs_drive_check"[\s\S]*?NOT VALID/,
    );
  });

});

describe('agent_workspaces.envId — an env owns its sessions', () => {
  it('given an env owns the sessions run inside it, should CASCADE rather than set null', () => {
    // NOT `set null`. A nulled binding leaves a row identical to a
    // never-provisioned ephemeral session, which would reprovision a fresh
    // empty Sprite on reopen instead of returning to the shared filesystem.
    // Nothing is lost to the cascade that is not layout: `conversations` has
    // no column pointing at a session (dropped at 0256) and a pane's
    // `targetId` carries no FK, so chat history is unreachable from here.
    expect(fkOnColumn(sessionsConfig, 'envId').onDelete).toBe('cascade');
    expect(sessionsColumns.envId.notNull).toBe(false);
  });

  it('should index boxId — every "is this box in use" guard reads it', () => {
    expect(sessionsConfig.indexes.some((index) => index.config.name === 'agent_workspaces_env_id_idx'))
      .toBe(true);
  });
});

describe('drive_envs sprite reclaim trigger (0263)', () => {
  it('should arm an AFTER DELETE trigger on drive_envs', () => {
    expect(triggerSql).toMatch(/CREATE TRIGGER drive_envs_sprite_reclaim/);
    expect(triggerSql).toMatch(/AFTER DELETE ON drive_envs/);
    expect(triggerSql).toMatch(/FOR EACH ROW/);
    expect(triggerSql).toMatch(/EXECUTE FUNCTION drive_envs_capture_sprite_reclaim\(\)/);
  });

  it('given it runs inside a delete the caller may not be privileged for, should be SECURITY DEFINER with a pinned search_path', () => {
    expect(triggerSql).toMatch(/SECURITY DEFINER/);
    expect(triggerSql).toMatch(/SET search_path = public/);
  });

  it('should rescue BOTH pointer halves into machine_sprite_reclaims', () => {
    expect(triggerSql).toMatch(
      /INSERT INTO public\.machine_sprite_reclaims \("sandboxId", "spriteInstanceId"\)/,
    );
  });

  it('given a reused name may now hold a newer VM, should ON CONFLICT DO UPDATE rather than DO NOTHING', () => {
    expect(triggerSql).toMatch(/ON CONFLICT \("sandboxId"\) DO UPDATE/);
    expect(triggerSql).toMatch(/COALESCE\(EXCLUDED\."spriteInstanceId"/);
    expect(triggerSql).not.toMatch(/ON CONFLICT[\s\S]{0,40}DO NOTHING/);
  });

  it('given a torn-down box has no VM to reclaim, should fire only on the live-pointer predicate', () => {
    expect(triggerSql).toMatch(
      /WHEN \(OLD\."sandboxId" IS NOT NULL AND OLD\."spriteTornDownAt" IS NULL\)/,
    );
  });

  it('should name exactly ONE outbox inside the function body, and it is the Sprite one', () => {
    // Asserting the ABSENCE of `app_hosting_reclaims` here would be vacuous:
    // that table exists nowhere in this schema (it arrives with PR #2425), so
    // the assertion could never fail for a real reason. What CAN regress is
    // this function growing a second INSERT, so count INSERT targets instead.
    //
    // Scoped to the FUNCTION BODY, not the file: the file is more than half
    // prose, and `stripComments` only drops whole-line comments, so a future
    // trailing `-- ... INSERT INTO x ...` would otherwise fail this test for a
    // reason that has nothing to do with the trigger.
    //
    // Being honest about the limit of a textual check: this measures the
    // statements the body NAMES. It cannot see an insert reached indirectly
    // (a `PERFORM some_helper()`), which is why the behavioural proof lives in
    // `src/__tests__/drive-envs-reclaim-trigger.integration.test.ts`, where
    // rows are actually deleted and the outbox is actually read.
    const body = triggerSql.slice(
      triggerSql.indexOf('AS $$'),
      triggerSql.indexOf('$$ LANGUAGE plpgsql'),
    );
    expect(body).not.toHaveLength(0);
    const targets = [...body.matchAll(/INSERT\s+INTO\s+([a-z0-9_."]+)/gi)]
      .map((m) => m[1].replace(/"/g, ''));
    expect(targets).toEqual(['public.machine_sprite_reclaims']);
  });
});

describe('drive_envs relations', () => {
  it('should declare relations against drive_envs itself', () => {
    // The `sessions` edge deliberately lives on `agentWorkspacesRelations`, not
    // here: declaring it would make this module import `agent-workspaces.ts`,
    // which already imports this one for the `boxId` FK. One direction, no cycle.
    expect(driveEnvsRelations.table).toBe(driveEnvs);
  });
});
