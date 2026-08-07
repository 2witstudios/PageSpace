/**
 * Installer behaviour, driven through the injected `client` rather than a
 * mocked drizzle module — `installStarterSkills` takes a DbClient precisely so
 * the provisioning transaction can pass its `tx`, and that same seam makes the
 * logic testable without a database.
 *
 * The invariants under test are the ones that would silently corrupt user data
 * if they regressed: never resurrect a deleted starter, never overwrite a
 * command the user already owns, never create a second Skills folder.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { users } from '@pagespace/db/schema/auth';
import { pages } from '@pagespace/db/schema/core';
import { commands } from '@pagespace/db/schema/commands';
import { installStarterSkills, type DbClient } from '../starter-skill-installer';
import { STARTER_SKILLS } from '../starter-skills';

interface FakeState {
  starterSkillsInstalledAt: Date | null;
  userExists: boolean;
  existingTriggers: string[];
  existingSkillsFolderId: string | null;
  /** Simulates onConflictDoNothing skipping the command insert (lost race). */
  commandInsertConflicts: boolean;
  insertedPages: Record<string, unknown>[];
  insertedCommands: Record<string, unknown>[];
  deletedPages: unknown[];
  userUpdates: Record<string, unknown>[];
  lockedRows: number;
}

function makeFakeClient(state: FakeState): DbClient {
  // Each chain step returns an object that is both awaitable and further
  // chainable, matching how the installer calls drizzle.
  const result = (rows: unknown[]) => {
    const chain = {
      from: (table: unknown) => {
        if (table === users) {
          return result(state.userExists ? [{ starterSkillsInstalledAt: state.starterSkillsInstalledAt }] : []);
        }
        if (table === commands) {
          return result(state.existingTriggers.map((trigger) => ({ trigger })));
        }
        if (table === pages) {
          return result(state.existingSkillsFolderId ? [{ id: state.existingSkillsFolderId }] : []);
        }
        return result([]);
      },
      where: () => chain,
      limit: () => chain,
      onConflictDoNothing: () => chain,
      returning: () => result(rows),
      then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
    };
    return chain;
  };

  return {
    // The FOR UPDATE lock the installer takes on the user row.
    execute: async () => {
      state.lockedRows += 1;
      return [];
    },
    select: () => result([]),
    insert: (table: unknown) => ({
      values: (row: Record<string, unknown>) => {
        if (table === pages) {
          state.insertedPages.push(row);
          return result([]);
        }
        state.insertedCommands.push(row);
        // An empty returning() is how drizzle reports an onConflictDoNothing skip.
        return result(state.commandInsertConflicts ? [] : [{ id: 'cmd-1' }]);
      },
    }),
    update: (table: unknown) => ({
      set: (row: Record<string, unknown>) => {
        if (table === users) state.userUpdates.push(row);
        return result([]);
      },
    }),
    delete: (table: unknown) => ({
      where: (predicate: unknown) => {
        if (table === pages) state.deletedPages.push(predicate);
        return result([]);
      },
    }),
  } as unknown as DbClient;
}

const baseState = (): FakeState => ({
  starterSkillsInstalledAt: null,
  userExists: true,
  existingTriggers: [],
  existingSkillsFolderId: null,
  commandInsertConflicts: false,
  insertedPages: [],
  insertedCommands: [],
  deletedPages: [],
  userUpdates: [],
  lockedRows: 0,
});

describe('installStarterSkills', () => {
  let state: FakeState;

  beforeEach(() => {
    state = baseState();
  });

  it('installs every starter skill for a fresh user', async () => {
    const result = await installStarterSkills('user-1', 'drive-home', makeFakeClient(state));

    expect(result.installed).toEqual(STARTER_SKILLS.map((s) => s.trigger));
    expect(result.skipped).toEqual([]);
    expect(result.alreadyInstalled).toBe(false);
  });

  it('creates the Skills folder plus one DOCUMENT page per skill', async () => {
    await installStarterSkills('user-1', 'drive-home', makeFakeClient(state));

    const folder = state.insertedPages.find((p) => p.type === 'FOLDER');
    expect(folder).toMatchObject({ title: 'Skills', driveId: 'drive-home' });
    // Root-level: the folder must sit at the Home drive root, not nested.
    expect(folder!.parentId).toBeUndefined();

    const docs = state.insertedPages.filter((p) => p.type === 'DOCUMENT');
    expect(docs).toHaveLength(STARTER_SKILLS.length);
    // Bodies are markdown; seeding them as the default 'html' would render the
    // skill as literal source in the editor.
    expect(docs.every((d) => d.contentMode === 'markdown')).toBe(true);
    expect(docs.every((d) => typeof d.content === 'string' && (d.content as string).length > 0)).toBe(true);
  });

  it('registers each page as a personal command owned by the user', async () => {
    await installStarterSkills('user-1', 'drive-home', makeFakeClient(state));

    expect(state.insertedCommands).toHaveLength(STARTER_SKILLS.length);
    for (const row of state.insertedCommands) {
      expect(row).toMatchObject({ userId: 'user-1', createdById: 'user-1', type: 'document', enabled: true });
      // A command with no live entry page is filtered out at load time, so the
      // page id must actually be threaded through.
      expect(typeof row.entryPageId).toBe('string');
    }
  });

  it('stamps the user so the install is not repeated', async () => {
    await installStarterSkills('user-1', 'drive-home', makeFakeClient(state));

    expect(state.userUpdates).toHaveLength(1);
    expect(state.userUpdates[0].starterSkillsInstalledAt).toBeInstanceOf(Date);
  });

  it('does nothing for an already-stamped user', async () => {
    state.starterSkillsInstalledAt = new Date('2026-01-01');

    const result = await installStarterSkills('user-1', 'drive-home', makeFakeClient(state));

    expect(result.alreadyInstalled).toBe(true);
    expect(result.installed).toEqual([]);
    expect(state.insertedPages).toEqual([]);
    expect(state.insertedCommands).toEqual([]);
    // Critically: no re-stamp and no re-insert. This is what stops a re-run of
    // the backfill from resurrecting a starter the user deliberately deleted.
    expect(state.userUpdates).toEqual([]);
  });

  it('never overwrites a trigger the user already owns', async () => {
    state.existingTriggers = ['plan'];

    const result = await installStarterSkills('user-1', 'drive-home', makeFakeClient(state));

    expect(result.skipped).toContain('plan');
    expect(result.installed).not.toContain('plan');
    expect(state.insertedCommands.some((c) => c.trigger === 'plan')).toBe(false);
  });

  it('still stamps the user when every starter was skipped', async () => {
    state.existingTriggers = STARTER_SKILLS.map((s) => s.trigger);

    await installStarterSkills('user-1', 'drive-home', makeFakeClient(state));

    // Otherwise every future run re-does this work to conclude nothing again.
    expect(state.userUpdates).toHaveLength(1);
    expect(state.insertedPages).toEqual([]);
  });

  it('reuses an existing Skills folder instead of creating a second one', async () => {
    state.existingSkillsFolderId = 'folder-existing';

    await installStarterSkills('user-1', 'drive-home', makeFakeClient(state));

    expect(state.insertedPages.some((p) => p.type === 'FOLDER')).toBe(false);
    expect(state.insertedPages.every((p) => p.parentId === 'folder-existing')).toBe(true);
  });

  it('no-ops for a user that does not exist', async () => {
    state.userExists = false;

    const result = await installStarterSkills('ghost', 'drive-home', makeFakeClient(state));

    expect(result).toEqual({ installed: [], skipped: [], alreadyInstalled: false });
    expect(state.insertedPages).toEqual([]);
    expect(state.userUpdates).toEqual([]);
  });
  it('locks the user row before reading the stamp', async () => {
    // The read-then-stamp must be atomic even when the CALLER holds no lock —
    // the backfill script does not. Without this, two concurrent runs both see
    // NULL and both install.
    const state2 = baseState();
    await installStarterSkills('user-1', 'drive-home', makeFakeClient(state2));
    expect(state2.lockedRows).toBe(1);
  });

  it('does not report a trigger as installed when the command insert is skipped', async () => {
    state.commandInsertConflicts = true;

    const result = await installStarterSkills('user-1', 'drive-home', makeFakeClient(state));

    // Over-reporting here would make the backfill summary claim installs that
    // never happened.
    expect(result.installed).toEqual([]);
    expect(result.skipped).toEqual(STARTER_SKILLS.map((s) => s.trigger));
  });

  it('deletes the orphaned page when the command insert is skipped', async () => {
    state.commandInsertConflicts = true;

    await installStarterSkills('user-1', 'drive-home', makeFakeClient(state));

    // Otherwise the Skills folder keeps a document that looks like a skill but
    // has no command pointing at it, so it can never be invoked.
    expect(state.deletedPages).toHaveLength(STARTER_SKILLS.length);
  });
});
