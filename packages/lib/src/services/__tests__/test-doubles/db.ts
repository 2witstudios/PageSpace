/**
 * Boundary-level test double for the channel + DM message repositories.
 *
 * The repositories were previously tested by mocking Drizzle's chained methods
 * with `.then`-able stubs (`mockUpdateWhere.mockReturnValue({ returning, then })`)
 * and asserting on the order of intermediate builder calls. That coupling meant
 * any internal refactor — e.g. flipping the order of `where(eq(a), eq(b))`
 * conjuncts, swapping `select().from().where()` for a relations query, or
 * inlining a step — broke tests without changing observable behavior.
 *
 * This module replaces those tests' boundary with an in-memory db that:
 *
 *  - Holds rows for each table (`channelMessages`, `directMessages`, …) and
 *    exposes them via `state.rows(name)` for assertions.
 *  - Implements the chained API the repositories actually call
 *    (`db.insert(t).values(r).returning()`, `db.update(t).set(p).where(pred).returning(cols)`,
 *    `db.select(cols).from(t).where(pred).for('update')`, `db.transaction(cb)`,
 *    `db.query.X.findFirst/findMany`, etc.) backed by real state mutation.
 *  - Wraps `db.transaction(cb)` with a snapshot/restore so a thrown callback
 *    rolls back ALL writes in that tx — the rollback edge cases test this.
 *  - Exposes a `failBefore` hook so a test can inject a throw at any
 *    `insert|update|delete` against any table without poking internals.
 *
 * Operators (`eq`, `and`, `or`, `lt`, `gt`, `isNull`, `isNotNull`) are mocked
 * to return row predicate functions instead of opaque marker objects, so the
 * `where(...)` step receives a function the double can call directly. This
 * means tests survive any refactor that re-orders or rebalances the predicate
 * tree — only the row-set the predicate selects matters.
 *
 * The `sql` tag is interpreted only for the two patterns the impl uses today:
 * `${col} + 1` (increment) and `GREATEST(${col} - 1, 0)` (clamped decrement).
 * Any other shape throws — so a future SQL fragment in the impl forces an
 * explicit decision in this file rather than silently returning the wrong
 * value.
 *
 * Fallback note: if a future test needs to mock a higher level (e.g., the
 * repository module itself, in route tests), do that — don't leak Drizzle
 * shape into yet more files.
 */

// ---------------------------------------------------------------------------
// Schema column + table markers
// ---------------------------------------------------------------------------

export interface ColumnRef {
  __col: true;
  table: string;
  name: string;
}

export interface TableRef {
  __table: true;
  __name: string;
  [columnName: string]: ColumnRef | string | true;
}

export function makeColumn(table: string, name: string): ColumnRef {
  return { __col: true, table, name };
}

export function makeTable(name: string, columns: readonly string[]): TableRef {
  const t: Record<string, ColumnRef | string | true> = {
    __table: true,
    __name: name,
  };
  for (const c of columns) t[c] = makeColumn(name, c);
  return t as TableRef;
}

const isColumn = (v: unknown): v is ColumnRef =>
  typeof v === 'object' && v !== null && (v as { __col?: true }).__col === true;

// ---------------------------------------------------------------------------
// Operators
// ---------------------------------------------------------------------------

export type RowPredicate = (row: Record<string, unknown>) => boolean;

export interface OrderSpec {
  __order: 'asc' | 'desc';
  col: ColumnRef;
}

export interface SqlMarker {
  __sql: true;
  strings: readonly string[];
  values: readonly unknown[];
}

const compare = (a: unknown, b: unknown): number => {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  // Fallback: string-coerce.
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
};

export const operators = {
  eq: (col: ColumnRef, value: unknown): RowPredicate =>
    (row) => row[col.name] === value,
  and: (...preds: Array<RowPredicate | undefined>): RowPredicate => {
    const cs = preds.filter((p): p is RowPredicate => typeof p === 'function');
    return (row) => cs.every((p) => p(row));
  },
  or: (...preds: Array<RowPredicate | undefined>): RowPredicate => {
    const cs = preds.filter((p): p is RowPredicate => typeof p === 'function');
    return (row) => cs.some((p) => p(row));
  },
  lt: (col: ColumnRef, value: unknown): RowPredicate =>
    (row) => compare(row[col.name], value) < 0,
  gt: (col: ColumnRef, value: unknown): RowPredicate =>
    (row) => compare(row[col.name], value) > 0,
  isNull: (col: ColumnRef): RowPredicate =>
    (row) => row[col.name] === null || row[col.name] === undefined,
  isNotNull: (col: ColumnRef): RowPredicate =>
    (row) => row[col.name] !== null && row[col.name] !== undefined,
  asc: (col: ColumnRef): OrderSpec => ({ __order: 'asc', col }),
  desc: (col: ColumnRef): OrderSpec => ({ __order: 'desc', col }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]): SqlMarker => ({
      __sql: true,
      strings: [...strings],
      values,
    }),
    {
      join: (items: unknown[], separator: unknown) => ({ __sqlJoin: true, items, separator }),
    }
  ),
};

const isSqlMarker = (v: unknown): v is SqlMarker =>
  typeof v === 'object' && v !== null && (v as { __sql?: true }).__sql === true;

// Interpret the two `sql` shapes the impl uses today. Any other shape is a
// bug — fail loudly instead of silently writing garbage.
function applySqlMarker(marker: SqlMarker, row: Record<string, unknown>): unknown {
  if (marker.values.length === 1 && isColumn(marker.values[0])) {
    const col = marker.values[0] as ColumnRef;
    const joined = marker.strings.join('@COL@');
    if (/^GREATEST\(@COL@\s*-\s*1,\s*0\)$/.test(joined)) {
      return Math.max(((row[col.name] as number) ?? 0) - 1, 0);
    }
    if (/^@COL@\s*\+\s*1$/.test(joined)) {
      return ((row[col.name] as number) ?? 0) + 1;
    }
  }
  throw new Error(
    `db double: unrecognized sql marker — strings=${JSON.stringify(marker.strings)}, values=${JSON.stringify(
      marker.values.map((v) => (isColumn(v) ? `${v.table}.${v.name}` : v))
    )}`
  );
}

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
type HookKind = 'insert' | 'update' | 'delete' | 'select';

interface HookEvent {
  kind: HookKind;
  table: string;
}

type Hook = (e: HookEvent) => void;

let nextAutoId = 0;
const autoId = () => `auto-${++nextAutoId}`;

const messageDefaults = (): Row => ({
  isActive: true,
  replyCount: 0,
  lastReplyAt: null,
  parentId: null,
  mirroredFromId: null,
  aiMeta: null,
  fileId: null,
  attachmentMeta: null,
  editedAt: null,
  isEdited: false,
  isRead: false,
  readAt: null,
  deletedAt: null,
});

function applyDefaults(table: string, row: Row): Row {
  const out: Row = { ...row };
  if (table === 'channelMessages' || table === 'directMessages') {
    const defaults = messageDefaults();
    for (const [k, v] of Object.entries(defaults)) {
      if (!(k in out)) out[k] = v;
    }
    if (!out.id) out.id = autoId();
    if (!('createdAt' in out)) out.createdAt = new Date();
  }
  if (
    table === 'channelMessageReactions' ||
    table === 'dmMessageReactions' ||
    table === 'channelThreadFollowers' ||
    table === 'dmThreadFollowers'
  ) {
    if (!out.id && (table === 'channelMessageReactions' || table === 'dmMessageReactions')) {
      out.id = autoId();
    }
    if (!('createdAt' in out)) out.createdAt = new Date();
  }
  return out;
}

export class DbState {
  private tables = new Map<string, Row[]>();
  private hooks = new Map<string, Hook[]>();
  private executeCalls: SqlMarker[] = [];

  seed(table: string, rows: Row[]): void {
    const cur = this.tables.get(table) ?? [];
    cur.push(...rows.map((r) => ({ ...r })));
    this.tables.set(table, cur);
  }

  rows(table: string): Row[] {
    return (this.tables.get(table) ?? []).map((r) => ({ ...r }));
  }

  rowsRef(table: string): Row[] {
    if (!this.tables.has(table)) this.tables.set(table, []);
    return this.tables.get(table) as Row[];
  }

  count(table: string): number {
    return (this.tables.get(table) ?? []).length;
  }

  executes(): readonly SqlMarker[] {
    return [...this.executeCalls];
  }

  recordExecute(marker: SqlMarker): void {
    this.executeCalls.push(marker);
  }

  /**
   * Inject a one-shot pre-op throw at the named table.
   * Use to simulate a follower-upsert failure or mirror-insert failure inside
   * a transaction — the wrapping `transaction(cb)` then rolls all writes back.
   *
   * `skip` lets the first N matching ops succeed before the throw fires —
   * useful when the impl performs multiple inserts against the same table in a
   * single tx and only the Nth one should fail (e.g. the mirror insert is the
   * second `channelMessages` insert in `insertChannelThreadReply`).
   */
  failBefore(
    kind: HookKind,
    table: string,
    options: { skip?: number; error?: Error } = {}
  ): void {
    const key = `${kind}:${table}`;
    const skipCount = options.skip ?? 0;
    const error = options.error ?? new Error(`${kind} ${table} failed`);
    let seen = 0;
    let fired = false;
    const hook: Hook = () => {
      if (fired) return;
      if (seen < skipCount) {
        seen += 1;
        return;
      }
      fired = true;
      throw error;
    };
    const arr = this.hooks.get(key) ?? [];
    arr.push(hook);
    this.hooks.set(key, arr);
  }

  runHooks(e: HookEvent): void {
    const key = `${e.kind}:${e.table}`;
    for (const h of this.hooks.get(key) ?? []) h(e);
  }

  snapshot(): Map<string, Row[]> {
    return new Map([...this.tables].map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
  }

  restore(snap: Map<string, Row[]>): void {
    this.tables = new Map([...snap].map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
  }

  reset(): void {
    this.tables.clear();
    this.hooks.clear();
    this.executeCalls.length = 0;
  }
}

function applySetPatch(patch: Record<string, unknown>, row: Row): Row {
  const next: Row = { ...row };
  for (const [field, value] of Object.entries(patch)) {
    if (isSqlMarker(value)) {
      next[field] = applySqlMarker(value, row);
    } else {
      next[field] = value;
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// Relations join — only what the repositories ask for today.
// ---------------------------------------------------------------------------

interface RelationCfg {
  columns?: Record<string, true>;
  with?: Record<string, RelationCfg>;
}

function projectColumns(row: Row | null | undefined, cols?: Record<string, true>): Row | null {
  if (!row) return null;
  if (!cols) return { ...row };
  const out: Row = {};
  for (const [k, v] of Object.entries(cols)) {
    if (v) out[k] = row[k];
  }
  return out;
}

function joinRelations(
  state: DbState,
  table: string,
  row: Row,
  withSpec: Record<string, RelationCfg> | undefined
): Row {
  if (!withSpec) return { ...row };
  const result: Row = { ...row };
  for (const [relName, relCfg] of Object.entries(withSpec)) {
    if (relName === 'user') {
      const fk = (table === 'directMessages' || table === 'dmMessageReactions')
        ? 'senderId'
        : 'userId';
      const userId = row[fk] ?? row.userId;
      const user = state.rowsRef('users').find((u) => u.id === userId);
      result.user = projectColumns(user, relCfg.columns);
    } else if (relName === 'sender') {
      const sender = state.rowsRef('users').find((u) => u.id === row.senderId);
      result.sender = projectColumns(sender, relCfg.columns);
    } else if (relName === 'file') {
      const file = state.rowsRef('files').find((f) => f.id === row.fileId);
      result.file = projectColumns(file, relCfg.columns);
    } else if (relName === 'reactions') {
      const reactionsTable =
        table === 'channelMessages' ? 'channelMessageReactions' : 'dmMessageReactions';
      const reactions = state.rowsRef(reactionsTable).filter((r) => r.messageId === row.id);
      result.reactions = reactions.map((rxn) =>
        joinRelations(state, reactionsTable, rxn, relCfg.with)
      );
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// db proxy
// ---------------------------------------------------------------------------

interface QueryFindFirstCfg {
  where?: RowPredicate;
  with?: Record<string, RelationCfg>;
  columns?: Record<string, true>;
  orderBy?: OrderSpec[];
}

interface QueryFindManyCfg extends QueryFindFirstCfg {
  limit?: number;
}

function sortRows(rows: Row[], orderBy: OrderSpec[]): Row[] {
  const sorted = [...rows];
  sorted.sort((a, b) => {
    for (const o of orderBy) {
      const cmp = compare(a[o.col.name], b[o.col.name]);
      if (cmp !== 0) return o.__order === 'asc' ? cmp : -cmp;
    }
    return 0;
  });
  return sorted;
}

export interface TestDb {
  state: DbState;
  insert: (table: TableRef) => InsertBuilder;
  update: (table: TableRef) => UpdateBuilder;
  delete: (table: TableRef) => DeleteBuilder;
  select: (cols?: Record<string, ColumnRef>) => SelectBuilder;
  query: Record<string, QueryApi>;
  transaction: <T>(cb: (tx: TestDb) => Promise<T>) => Promise<T>;
  execute: (marker: SqlMarker) => Promise<{ rows: Row[] }>;
}

type Thenable<T> = {
  then<T1 = T, T2 = never>(
    onFulfilled?: ((value: T) => T1 | PromiseLike<T1>) | null,
    onRejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null
  ): Promise<T1 | T2>;
};

interface InsertBuilder {
  values: (rowOrRows: Row | Row[]) => InsertChain;
}

interface InsertChain extends Thenable<Row[]> {
  returning: () => Promise<Row[]>;
  onConflictDoNothing: () => Promise<Row[]>;
  onConflictDoUpdate: (cfg: { target: ColumnRef[]; set: Record<string, unknown> }) => Promise<Row[]>;
}

interface UpdateBuilder {
  set: (patch: Record<string, unknown>) => UpdateSet;
}

interface UpdateSet {
  where: (pred: RowPredicate) => UpdateChain;
}

interface UpdateChain extends Thenable<Row[]> {
  returning: (cols?: Record<string, ColumnRef>) => Promise<Row[]>;
}

interface DeleteBuilder {
  where: (pred: RowPredicate) => DeleteChain;
}

interface DeleteChain extends Thenable<Row[]> {
  returning: (cols?: Record<string, ColumnRef>) => Promise<Row[]>;
}

interface SelectBuilder {
  from: (table: TableRef) => SelectFrom;
}

interface SelectFrom {
  where: (pred: RowPredicate) => SelectWhere;
}

interface SelectWhere extends Thenable<Row[]> {
  for: (mode: string) => Promise<Row[]>;
  orderBy: (...orders: OrderSpec[]) => SelectOrdered;
}

interface SelectOrdered {
  limit: (n: number) => Promise<Row[]>;
}

const makeThen = <T>(produce: () => T) =>
  <T1 = T, T2 = never>(
    onFulfilled?: ((value: T) => T1 | PromiseLike<T1>) | null,
    onRejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null
  ): Promise<T1 | T2> =>
    new Promise<T>((resolve, reject) => {
      try {
        resolve(produce());
      } catch (e) {
        reject(e);
      }
    }).then(onFulfilled ?? undefined, onRejected ?? undefined);

interface QueryApi {
  findFirst: (cfg?: QueryFindFirstCfg) => Promise<Row | undefined>;
  findMany: (cfg?: QueryFindManyCfg) => Promise<Row[]>;
}

const QUERY_TABLES = [
  'channelMessages',
  'channelMessageReactions',
  'directMessages',
  'dmMessageReactions',
  'dmConversations',
  'files',
  'fileConversations',
  'users',
  'pages',
] as const;

export function makeDb(state: DbState): TestDb {
  const db: TestDb = {
    state,
    insert: (table) => makeInsertBuilder(state, table),
    update: (table) => makeUpdateBuilder(state, table),
    delete: (table) => makeDeleteBuilder(state, table),
    select: (cols) => makeSelectBuilder(state, cols),
    query: Object.fromEntries(
      QUERY_TABLES.map((t) => [t, makeQueryApi(state, t)])
    ) as Record<string, QueryApi>,
    transaction: async <T>(cb: (tx: TestDb) => Promise<T>): Promise<T> => {
      const snap = state.snapshot();
      try {
        return await cb(db);
      } catch (err) {
        state.restore(snap);
        throw err;
      }
    },
    execute: async (marker) => {
      state.recordExecute(marker);
      return { rows: [] };
    },
  };
  return db;
}

function makeInsertBuilder(state: DbState, table: TableRef): InsertBuilder {
  return {
    values: (rowOrRows) => {
      const rows = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];
      let mode: 'plain' | 'doNothing' | 'doUpdate' = 'plain';
      let conflictTarget: ColumnRef[] | null = null;
      let conflictSet: Record<string, unknown> | null = null;
      const finalize = (): Row[] => {
        state.runHooks({ kind: 'insert', table: table.__name });
        const tableRows = state.rowsRef(table.__name);
        const inserted: Row[] = [];
        for (const r of rows) {
          const withDefaults = applyDefaults(table.__name, r);
          const target = conflictTarget;
          const dupIdx =
            target !== null
              ? tableRows.findIndex((existing) =>
                  target.every((c) => existing[c.name] === withDefaults[c.name])
                )
              : -1;
          if (mode !== 'plain' && dupIdx >= 0) {
            if (mode === 'doUpdate' && conflictSet) {
              tableRows[dupIdx] = applySetPatch(conflictSet, tableRows[dupIdx]);
            }
            // doNothing: skip silently
          } else {
            tableRows.push(withDefaults);
            inserted.push({ ...withDefaults });
          }
        }
        return inserted;
      };
      const chain: InsertChain = {
        returning: async () => finalize(),
        onConflictDoNothing: async () => {
          mode = 'doNothing';
          // For onConflictDoNothing without an explicit target, the impl relies
          // on a unique index. The PRs use either a composite pk on the
          // followers table (rootMessageId, userId) or the reactions table
          // unique constraint. Synthesize a reasonable default per-table.
          conflictTarget = defaultConflictTarget(table.__name);
          return finalize();
        },
        onConflictDoUpdate: async (cfg) => {
          mode = 'doUpdate';
          conflictTarget = cfg.target;
          conflictSet = cfg.set;
          return finalize();
        },
        then: makeThen<Row[]>(() => finalize()),
      };
      return chain;
    },
  };
}

function defaultConflictTarget(tableName: string): ColumnRef[] {
  switch (tableName) {
    case 'channelThreadFollowers':
    case 'dmThreadFollowers':
      return [makeColumn(tableName, 'rootMessageId'), makeColumn(tableName, 'userId')];
    case 'channelMessageReactions':
    case 'dmMessageReactions':
      return [
        makeColumn(tableName, 'messageId'),
        makeColumn(tableName, 'userId'),
        makeColumn(tableName, 'emoji'),
      ];
    default:
      return [makeColumn(tableName, 'id')];
  }
}

function makeUpdateBuilder(state: DbState, table: TableRef): UpdateBuilder {
  return {
    set: (patch) => ({
      where: (pred) => {
        const finalize = (cols?: Record<string, ColumnRef>): Row[] => {
          state.runHooks({ kind: 'update', table: table.__name });
          const tableRows = state.rowsRef(table.__name);
          const updated: Row[] = [];
          for (let i = 0; i < tableRows.length; i++) {
            if (pred(tableRows[i])) {
              tableRows[i] = applySetPatch(patch, tableRows[i]);
              updated.push({ ...tableRows[i] });
            }
          }
          if (cols) {
            return updated.map((r) =>
              Object.fromEntries(
                Object.entries(cols).map(([alias, col]) => [alias, r[col.name]])
              )
            );
          }
          return updated;
        };
        const chain: UpdateChain = {
          returning: async (cols) => finalize(cols),
          then: makeThen<Row[]>(() => finalize()),
        };
        return chain;
      },
    }),
  };
}

function makeDeleteBuilder(state: DbState, table: TableRef): DeleteBuilder {
  return {
    where: (pred) => {
      const finalize = (cols?: Record<string, ColumnRef>): Row[] => {
        state.runHooks({ kind: 'delete', table: table.__name });
        const tableRows = state.rowsRef(table.__name);
        const removed: Row[] = [];
        for (let i = tableRows.length - 1; i >= 0; i--) {
          if (pred(tableRows[i])) {
            removed.unshift({ ...tableRows[i] });
            tableRows.splice(i, 1);
          }
        }
        if (cols) {
          return removed.map((r) =>
            Object.fromEntries(
              Object.entries(cols).map(([alias, col]) => [alias, r[col.name]])
            )
          );
        }
        return removed;
      };
      const chain: DeleteChain = {
        returning: async (cols) => finalize(cols),
        then: makeThen<Row[]>(() => finalize()),
      };
      return chain;
    },
  };
}

function makeSelectBuilder(state: DbState, cols?: Record<string, ColumnRef>): SelectBuilder {
  return {
    from: (table) => ({
      where: (pred) => {
        const buildResult = (rows: Row[]): Row[] => {
          if (cols) {
            return rows.map((r) =>
              Object.fromEntries(
                Object.entries(cols).map(([alias, col]) => [alias, r[col.name]])
              )
            );
          }
          return rows.map((r) => ({ ...r }));
        };
        const filter = (): Row[] => {
          state.runHooks({ kind: 'select', table: table.__name });
          return state.rowsRef(table.__name).filter(pred);
        };
        const chain: SelectWhere = {
          for: async (_mode) => buildResult(filter()),
          orderBy: (...orders) => ({
            limit: async (n) => buildResult(sortRows(filter(), orders).slice(0, n)),
          }),
          then: makeThen<Row[]>(() => buildResult(filter())),
        };
        return chain;
      },
    }),
  };
}

function makeQueryApi(state: DbState, table: string): QueryApi {
  return {
    findFirst: async (cfg = {}) => {
      let rows = state.rowsRef(table).filter(cfg.where ?? (() => true));
      if (cfg.orderBy) rows = sortRows(rows, cfg.orderBy);
      const first = rows[0];
      if (!first) return undefined;
      const joined = joinRelations(state, table, first, cfg.with);
      if (cfg.columns) {
        const projected = projectColumns(joined, cfg.columns);
        return projected ?? undefined;
      }
      return joined;
    },
    findMany: async (cfg = {}) => {
      let rows = state.rowsRef(table).filter(cfg.where ?? (() => true));
      if (cfg.orderBy) rows = sortRows(rows, cfg.orderBy);
      if (cfg.limit !== undefined) rows = rows.slice(0, cfg.limit);
      return rows.map((r) => {
        const joined = joinRelations(state, table, r, cfg.with);
        if (cfg.columns) return projectColumns(joined, cfg.columns) ?? joined;
        return joined;
      });
    },
  };
}

// ---------------------------------------------------------------------------
// vi.mock factories — tests import these from their vi.mock(...) calls.
// ---------------------------------------------------------------------------

export const chatSchema = {
  channelMessages: makeTable('channelMessages', [
    'id', 'pageId', 'userId', 'content', 'fileId', 'attachmentMeta',
    'isActive', 'editedAt', 'createdAt', 'parentId', 'replyCount',
    'lastReplyAt', 'mirroredFromId', 'aiMeta',
  ]),
  channelMessageReactions: makeTable('channelMessageReactions', [
    'id', 'messageId', 'userId', 'emoji', 'createdAt',
  ]),
  channelReadStatus: makeTable('channelReadStatus', [
    'userId', 'channelId', 'lastReadAt',
  ]),
  channelThreadFollowers: makeTable('channelThreadFollowers', [
    'rootMessageId', 'userId', 'createdAt',
  ]),
};

export const socialSchema = {
  dmConversations: makeTable('dmConversations', [
    'id', 'participant1Id', 'participant2Id', 'lastMessageAt',
    'lastMessagePreview', 'participant1LastRead', 'participant2LastRead',
  ]),
  directMessages: makeTable('directMessages', [
    'id', 'conversationId', 'senderId', 'content', 'fileId',
    'attachmentMeta', 'isRead', 'readAt', 'isActive', 'isEdited',
    'editedAt', 'deletedAt', 'createdAt', 'parentId', 'replyCount',
    'lastReplyAt', 'mirroredFromId',
  ]),
  dmThreadFollowers: makeTable('dmThreadFollowers', [
    'rootMessageId', 'userId', 'createdAt',
  ]),
  dmMessageReactions: makeTable('dmMessageReactions', [
    'id', 'messageId', 'userId', 'emoji', 'createdAt',
  ]),
};

export const storageSchema = {
  files: makeTable('files', ['id', 'mimeType', 'sizeBytes', 'createdBy']),
  fileConversations: makeTable('fileConversations', ['fileId', 'conversationId']),
};

// File-scope singletons — Vitest workers run each test file in its own VM
// context, so these don't leak across files. Tests reset them between cases
// with `state.reset()`.
export const testDbState = new DbState();
export const testDb = makeDb(testDbState);

// Convenience pre-bound mock factories so tests can write
//   vi.mock('@pagespace/db/db', () => testDbDbMock);
// in a single line. We can't expose these as plain functions because vi.mock
// factories are hoisted above any imports — instead each call site uses
// `() => import('./test-doubles/db').then(m => ...)` (see channel-message-repository.test.ts).
