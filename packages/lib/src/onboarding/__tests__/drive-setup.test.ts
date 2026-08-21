import { describe, expect, test, beforeEach, vi } from 'vitest';

vi.mock('@pagespace/db/db', () => ({
  db: { transaction: vi.fn() },
}));
vi.mock('@pagespace/db/operators', () => ({
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  eq: vi.fn((field: unknown, value: unknown) => ({ eq: [field, value] })),
  isNull: vi.fn((field: unknown) => ({ isNull: field })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values })),
}));
vi.mock('@pagespace/db/schema/core', () => ({
  drives: { id: 'drives.id' },
  pages: { driveId: 'pages.driveId', parentId: 'pages.parentId', id: 'pages.id' },
}));
vi.mock('@pagespace/db/schema/tasks', () => ({
  taskItems: { __table: 'taskItems' },
  taskLists: { __table: 'taskLists' },
}));
vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn().mockReturnValue('generated-id'),
}));
vi.mock('../../ai/model-defaults', () => ({
  DEFAULT_AI_PROVIDER: 'openai',
  DEFAULT_AI_MODEL: 'openai/gpt-5.6-luna',
}));
vi.mock('../onboarding-faq', () => ({
  getAboutPageSpaceAgentSystemPrompt: vi.fn().mockReturnValue('system-prompt'),
  getReferenceSeedTemplate: vi.fn().mockReturnValue({
    title: 'Reference',
    type: 'FOLDER',
    content: '',
    children: [],
  }),
}));
vi.mock('../faq/content-page-types', () => ({
  buildBudgetSheetContent: vi.fn().mockReturnValue(''),
}));
vi.mock('../faq/example-agent-prompts', () => ({
  PLANNING_ASSISTANT_SYSTEM_PROMPT: 'planning-prompt',
}));

import { pages } from '@pagespace/db/schema/core';
import { populateUserDrive } from '../drive-setup';

interface InsertCall {
  table: unknown;
  data: { parentId?: string; type?: string; title?: string };
}

/**
 * A database stand-in that models the two properties the seeder relies on:
 * inserted rows are visible to the next reader, and transaction bodies for the
 * same drive run one at a time — which is what the `SELECT … FOR UPDATE` on the
 * drive row buys in Postgres, and which the fake grants unconditionally.
 *
 * That last point bounds what these tests can prove. Serialisation is assumed
 * here, not demonstrated: what they check is that the seeder does the right
 * thing GIVEN it — skip when the scope is already filled. That the lock is
 * actually taken, and taken before the check, is a separate test below.
 *
 * The existence query is not filtered by drive/parent here — every test uses a
 * single scope, so any recorded page insert stands for "the scope is occupied".
 */
function makeFakeDb() {
  const inserts: InsertCall[] = [];
  const executes: unknown[] = [];
  let queue: Promise<unknown> = Promise.resolve();

  const tx = {
    execute: vi.fn(async (statement: unknown) => {
      executes.push(statement);
    }),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () =>
            inserts.filter((call) => call.table === pages).slice(0, 1).map(() => ({ id: 'existing' }))
          ),
        })),
      })),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn(async (data: InsertCall['data']) => {
        inserts.push({ table, data });
      }),
    })),
  };

  const db = {
    transaction: vi.fn((body: (tx: unknown) => Promise<unknown>) => {
      const run = queue.then(() => body(tx));
      queue = run.then(
        () => undefined,
        () => undefined
      );
      return run;
    }),
  };

  return {
    db,
    tx,
    executes,
    pageInserts: () => inserts.filter((call) => call.table === pages),
  };
}

type SeederClient = Parameters<typeof populateUserDrive>[2];

describe('populateUserDrive – idempotency', () => {
  let fake: ReturnType<typeof makeFakeDb>;

  beforeEach(() => {
    fake = makeFakeDb();
  });

  test('given an empty drive, seeds the starter pages and reports seeded:true', async () => {
    const result = await populateUserDrive('user-1', 'drive-1', fake.db as unknown as SeederClient);

    expect(result).toEqual({ seeded: true });
    expect(fake.pageInserts().length).toBeGreaterThan(0);
  });

  test('given an already-seeded drive, re-running is a no-op rather than a second copy', async () => {
    await populateUserDrive('user-1', 'drive-1', fake.db as unknown as SeederClient);
    const afterFirstRun = fake.pageInserts().length;

    const result = await populateUserDrive('user-1', 'drive-1', fake.db as unknown as SeederClient);

    expect(result).toEqual({ seeded: false });
    expect(fake.pageInserts()).toHaveLength(afterFirstRun);
  });

  test('given two seeders serialised on the same drive, only the first seeds', async () => {
    const [first, second] = await Promise.all([
      populateUserDrive('user-1', 'drive-1', fake.db as unknown as SeederClient),
      populateUserDrive('user-1', 'drive-1', fake.db as unknown as SeederClient),
    ]);

    expect([first.seeded, second.seeded].filter(Boolean)).toHaveLength(1);
    // One "Welcome to PageSpace" page, not two.
    const welcomePages = fake
      .pageInserts()
      .filter((call) => call.data.title === 'Welcome to PageSpace');
    expect(welcomePages).toHaveLength(1);
  });

  test('takes the drive row lock before deciding whether to seed', async () => {
    await populateUserDrive('user-1', 'drive-1', fake.db as unknown as SeederClient);

    expect(fake.tx.execute).toHaveBeenCalled();
    const lockStatement = JSON.stringify(fake.executes[0]);
    expect(lockStatement).toContain('FOR UPDATE');
    // The existence check must come after the lock, or the race is still open.
    expect(fake.tx.execute.mock.invocationCallOrder[0]).toBeLessThan(
      fake.tx.select.mock.invocationCallOrder[0]
    );
  });
});

describe('populateUserDrive – rootParentId option', () => {
  let fake: ReturnType<typeof makeFakeDb>;

  beforeEach(() => {
    fake = makeFakeDb();
  });

  test('without options, top-level inserts have no parentId', async () => {
    await populateUserDrive('user-1', 'drive-1', fake.db as unknown as SeederClient);

    expect(fake.pageInserts()[0].data.parentId).toBeUndefined();
  });

  test('with rootParentId option, top-level inserts use it as parentId', async () => {
    await populateUserDrive('user-1', 'drive-1', fake.db as unknown as SeederClient, {
      rootParentId: 'folder-root',
    });

    expect(fake.pageInserts()[0].data.parentId).toBe('folder-root');
  });

  test('with rootParentId option, task-list child pages still use their own explicit parentId', async () => {
    await populateUserDrive('user-1', 'drive-1', fake.db as unknown as SeederClient, {
      rootParentId: 'folder-root',
    });

    const taskChildPages = fake
      .pageInserts()
      .filter(
        (call) =>
          call.data.type === 'TASK_LIST' &&
          call.data.parentId !== 'folder-root' &&
          call.data.parentId !== undefined
      );
    expect(taskChildPages.length).toBeGreaterThan(0);
  });
});
