/**
 * Drive boxes — schema-level proof of the invariants Phases 2–6 are allowed to
 * assume. These run without a database: they assert the Drizzle declarations
 * the migrations were generated from, plus the reclaim trigger's SQL text.
 *
 * The four that must never silently regress:
 *
 *  - **A Sprite belongs to exactly ONE row.** A box-bound session holds no
 *    Sprite pointer (`agent_workspaces_box_no_sprite_check`) and borrows its
 *    box's. If that CHECK goes, two rows can claim one VM: ending one session
 *    tears down a filesystem other sessions are still using, and both AFTER
 *    DELETE triggers enqueue the same name.
 *  - **Substrate is derived, never stored.** No substrate (and no status)
 *    column exists here; `substrateForBoxKind` is the single source of truth.
 *    A stored copy is a second witness free to disagree with `kind`, and this
 *    particular disagreement picks the wrong provisioner and the wrong reclaim
 *    outbox.
 *  - **Deploy boxes hold no Sprite pointers** (`drive_boxes_sprite_kind_check`)
 *    — so the reclaim trigger can only ever hand `machine_sprite_reclaims` a
 *    pointer it knows how to kill. (The Fly-side outbox that would complete the
 *    partition does not exist yet; see the schema docblock.)
 *  - **A Sprite pointer outlives its row.** Every delete path into
 *    `drive_boxes` cascades (drive delete, permanent drive delete, Art. 17
 *    erasure through the drive), so the AFTER DELETE trigger must rescue
 *    `sandboxId`/`spriteInstanceId` into the outbox or a live VM bills forever
 *    with nothing pointing at it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { getTableColumns } from 'drizzle-orm';
import { driveBoxes, driveBoxKind, driveBoxesRelations } from '../drive-boxes';
import { agentWorkspaces } from '../agent-workspaces';

const boxesConfig = getTableConfig(driveBoxes);
const boxesColumns = getTableColumns(driveBoxes);
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
  readFileSync(path.join(MIGRATIONS_DIR, '0263_drive_boxes_reclaim_trigger.sql'), 'utf8'),
);
const schemaSql = stripComments(
  readFileSync(path.join(MIGRATIONS_DIR, '0262_long_nightmare.sql'), 'utf8'),
);

describe('drive_boxes schema — identity and ownership', () => {
  it('given a box is a drive entity and not a page, should key on its own cuid2 with a NOT NULL drive', () => {
    expect(boxesConfig.name).toBe('drive_boxes');
    expect(boxesColumns.id.primary).toBe(true);
    expect(boxesColumns.driveId.notNull).toBe(true);
    // No page linkage of any kind — the deleted MACHINE page type must not
    // come back through a column.
    expect('pageId' in boxesColumns).toBe(false);
  });

  it('given the drive owns the box, should CASCADE from drives and only SET NULL from the creator', () => {
    expect(fkOnColumn(boxesConfig, 'driveId').onDelete).toBe('cascade');
    // `createdBy` is audit only. Cascading it would delete a machine the drive
    // still uses because the person who clicked "create" left.
    expect(fkOnColumn(boxesConfig, 'createdBy').onDelete).toBe('set null');
    expect(boxesColumns.createdBy.notNull).toBe(false);
  });

  it('given a box is a deliberate deploy target, should make (driveId, name) unique', () => {
    const unique = boxesConfig.indexes.find((index) => index.config.name === 'drive_boxes_drive_name_idx');
    expect(unique?.config.unique).toBe(true);
    expect(unique?.config.columns.map((column) => (column as { name: string }).name))
      .toEqual(['driveId', 'name']);
    expect(boxesColumns.name.notNull).toBe(true);
  });
});

describe('drive_boxes schema — derived state, not stored state', () => {
  it('given substrate is derived from kind, should store NO substrate column', () => {
    expect('substrate' in boxesColumns).toBe(false);
    expect(driveBoxKind.enumValues).toEqual(['dev', 'staging', 'deploy']);
  });

  it('given status is derived from the pointer columns, should store NO status column', () => {
    expect('status' in boxesColumns).toBe(false);
  });
});

describe('drive_boxes schema — sprite identity mirrors agent_workspaces', () => {
  it('should carry every sprite identity and storage column the session table carries', () => {
    for (const column of [
      'spriteKey', 'sandboxId', 'spriteInstanceId', 'egressPolicyToken',
      'teardownRequestedAt', 'spriteTornDownAt',
      'storageLastBilledAt', 'storageMeasuredBytes', 'storageMeasuredAt',
      'lastActiveAt',
    ]) {
      expect(column in boxesColumns, `drive_boxes.${column}`).toBe(true);
      expect(column in sessionsColumns, `agent_workspaces.${column}`).toBe(true);
    }
  });

  it('given a box exists before (and possibly without) a Sprite, should leave every pointer nullable', () => {
    for (const column of ['spriteKey', 'sandboxId', 'spriteInstanceId', 'egressPolicyToken'] as const) {
      expect(boxesColumns[column].notNull, column).toBe(false);
    }
    // The one storage column that is NOT NULL, for the same reason it is on
    // the session table: a NULL watermark would bill the box retroactively to
    // the epoch on its first reconcile.
    expect(boxesColumns.storageLastBilledAt.notNull).toBe(true);
    expect(boxesColumns.storageLastBilledAt.hasDefault).toBe(true);
  });

  it('given the storage reconcile reads both row sources, should measure bytes as a JS number bigint', () => {
    expect(boxesColumns.storageMeasuredBytes.getSQLType()).toBe('bigint');
    expect(boxesColumns.storageMeasuredBytes.getSQLType())
      .toBe(sessionsColumns.storageMeasuredBytes.getSQLType());
  });

  it('given the crons scan "still believed live", should index exactly that partial slice', () => {
    const live = boxesConfig.indexes.find((index) => index.config.name === 'drive_boxes_live_sprite_idx');
    expect(live).toBeDefined();
    expect(live?.config.unique).toBe(false);
    expect(live?.config.columns.map((column) => (column as { name: string }).name))
      .toEqual(['sandboxId', 'spriteTornDownAt']);
    expect(live?.config.where).toBeDefined();
  });
});

describe('drive_boxes schema — the two CHECKs that partition the outboxes', () => {
  it('given deploy boxes run on Fly, should forbid every sprite identity column on them', () => {
    const sql = checkSql(boxesConfig, 'drive_boxes_sprite_kind_check');
    expect(sql).toContain('dev');
    expect(sql).toContain('staging');
    for (const column of ['sandboxId', 'spriteKey', 'spriteInstanceId']) {
      expect(sql, `predicate must mention ${column}`).toContain(column);
    }
  });

  it('given a box-bound session borrows the box sprite, should forbid its own pointers', () => {
    const sql = checkSql(sessionsConfig, 'agent_workspaces_box_no_sprite_check');
    expect(sql).toContain('boxId');
    for (const column of ['sandboxId', 'spriteKey', 'spriteInstanceId']) {
      expect(sql, `predicate must mention ${column}`).toContain(column);
    }
  });

  it('given agent_workspaces is populated, should ship its CHECK NOT VALID with the VALIDATE deferred', () => {
    expect(schemaSql).toMatch(
      /ADD CONSTRAINT "agent_workspaces_box_no_sprite_check"[\s\S]*?NOT VALID/,
    );
    // Stage 2 must NOT ride this release: every pending migration runs in one
    // invocation, so a VALIDATE here would execute seconds after the ADD.
    expect(schemaSql).not.toMatch(/VALIDATE CONSTRAINT/);
  });

  it('given a box is drive-owned, should refuse a box-bound session that has no drive', () => {
    const sql = checkSql(sessionsConfig, 'agent_workspaces_box_needs_drive_check');
    expect(sql).toContain('boxId');
    expect(sql).toContain('driveId');
    // The other half of drive-agreement — that the box belongs to THIS
    // session's drive — is Phase 3's `spawnAgentSession`, deliberately (see the
    // constraint's docblock). This test is the marker for that follow-up.
    expect(schemaSql).toMatch(
      /ADD CONSTRAINT "agent_workspaces_box_needs_drive_check"[\s\S]*?NOT VALID/,
    );
  });

  it('given drive_boxes is created empty in the same statement, should declare ITS check inline', () => {
    // Inline in CREATE TABLE, which is what makes it VALID from birth — there
    // is no separate ADD CONSTRAINT that could have carried a NOT VALID.
    //
    // Deliberately NOT asserted by measuring the distance to the nearest
    // `NOT VALID` in the file: that passes or fails on statement ORDER, so it
    // would silently stop meaning anything the first time 0262 is reordered.
    // The authoritative check is `convalidated` in `pg_constraint`, asserted
    // against a real database in
    // `src/__tests__/drive-boxes-reclaim-trigger.integration.test.ts`.
    const createTable = schemaSql.slice(
      schemaSql.indexOf('CREATE TABLE "drive_boxes"'),
      schemaSql.indexOf('ALTER TABLE "agent_workspaces" ADD COLUMN "boxId"'),
    );
    expect(createTable).toContain('CONSTRAINT "drive_boxes_sprite_kind_check" CHECK');
    expect(createTable).not.toContain('NOT VALID');
  });
});

describe('agent_workspaces.boxId — a box owns its sessions', () => {
  it('given a box owns the sessions run inside it, should CASCADE rather than set null', () => {
    // NOT `set null`. A nulled binding leaves a row identical to a
    // never-provisioned ephemeral session, which would reprovision a fresh
    // empty Sprite on reopen instead of returning to the shared filesystem.
    // Nothing is lost to the cascade that is not layout: `conversations` has
    // no column pointing at a session (dropped at 0256) and a pane's
    // `targetId` carries no FK, so chat history is unreachable from here.
    expect(fkOnColumn(sessionsConfig, 'boxId').onDelete).toBe('cascade');
    expect(sessionsColumns.boxId.notNull).toBe(false);
  });

  it('should index boxId — every "is this box in use" guard reads it', () => {
    expect(sessionsConfig.indexes.some((index) => index.config.name === 'agent_workspaces_box_id_idx'))
      .toBe(true);
  });
});

describe('drive_boxes sprite reclaim trigger (0263)', () => {
  it('should arm an AFTER DELETE trigger on drive_boxes', () => {
    expect(triggerSql).toMatch(/CREATE TRIGGER drive_boxes_sprite_reclaim/);
    expect(triggerSql).toMatch(/AFTER DELETE ON drive_boxes/);
    expect(triggerSql).toMatch(/FOR EACH ROW/);
    expect(triggerSql).toMatch(/EXECUTE FUNCTION drive_boxes_capture_sprite_reclaim\(\)/);
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
    // `src/__tests__/drive-boxes-reclaim-trigger.integration.test.ts`, where
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

describe('drive_boxes relations', () => {
  it('should declare relations against drive_boxes itself', () => {
    // The `sessions` edge deliberately lives on `agentWorkspacesRelations`, not
    // here: declaring it would make this module import `agent-workspaces.ts`,
    // which already imports this one for the `boxId` FK. One direction, no cycle.
    expect(driveBoxesRelations.table).toBe(driveBoxes);
  });
});
