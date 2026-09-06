/**
 * DRIFT GUARD for the Art 15 subject access export.
 *
 * THE FAILURE THIS EXISTS TO CATCH
 * --------------------------------
 * `gdpr-export.ts` is a hand-written list of collectors, and nothing tied that
 * list to the schema. So a table added to `packages/db/src/schema/` simply
 * never appeared in anybody's export — and the omission was invisible in every
 * direction: the ZIP built, the route test passed, and the data was absent
 * from every subject access request.
 *
 * It happened. The epic "Agent-Session Single Source of Truth" moved a large
 * amount of user work into `agent_workspaces`, `agent_workspace_shells` and
 * `ai_stream_sessions`, and no collector followed. Erasure DID follow (the
 * `users` cascade plus the `purge-stream-state` step), so we reached that
 * content on an Art 17 request while failing to disclose it on an Art 15 one.
 * The route test made it worse than neutral: it asserted the CURRENT category
 * list, so it pinned the omission in place instead of catching it.
 *
 * A test written against the collectors could never have caught that — you
 * cannot assert the absence of a collector you did not think of. So this test
 * starts from the SCHEMA instead: it enumerates the Drizzle table objects at
 * runtime (the technique `scripts/__tests__/tenant-export-columns.test.ts`
 * already uses for the tenant bundle) and requires each one to carry a recorded
 * decision in `gdpr-export-coverage.ts`, in both directions:
 *
 *   1. every schema table is exported or explicitly excluded → catches an
 *      ADDED table nobody decided about (the actual historical failure);
 *   2. every registered name still exists in the schema      → catches a
 *      renamed/dropped table left behind, which would make the registry lie;
 *   3. exported ∩ excluded = ∅, every exclusion states a substantive reason,
 *      and every exported table names a real `AllUserData` category → keeps
 *      "not carried" a decision someone wrote down rather than an omission.
 *
 * It needs no database: the table objects describe themselves.
 */
import { describe, it, expect } from 'vitest';
import { getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import * as dbSchema from '@pagespace/db/schema';
import { EXPORTED_TABLES, EXCLUDED_TABLES, registeredTables } from './gdpr-export-coverage';
import { buildNativeExportFiles } from './export-format';
import type { AllUserData } from './gdpr-export';

/** Every SQL table name the db package's schema defines. */
function schemaTableNames(): string[] {
  const names: string[] = [];
  for (const value of Object.values(dbSchema as Record<string, unknown>)) {
    if (value && is(value, PgTable)) names.push(getTableName(value));
  }
  return [...new Set(names)].sort();
}

const SCHEMA_TABLES = schemaTableNames();

/**
 * An empty `AllUserData`. Its KEYS are what the registry's category values are
 * checked against — built from a literal rather than from a type-only helper so
 * a category added to the interface without a file in the bundle is caught by
 * the bundle test below rather than passing silently.
 */
const EMPTY: AllUserData = {
  profile: { id: 'u', name: 'n', email: 'e', image: null, timezone: null, createdAt: new Date(0), updatedAt: new Date(0) },
  drives: [],
  pages: [],
  sheets: [],
  messages: [],
  files: [],
  activity: [],
  systemLogs: [],
  apiMetrics: [],
  errorLogs: [],
  aiUsage: [],
  tasks: [],
  sessions: [],
  notifications: [],
  displayPreferences: [],
  settings: { hotkeys: [], automation: null, toastNotifications: null, emailNotifications: [] },
  personalization: null,
  personalizationCandidates: [],
  agentWorkspaces: [],
  streamState: [],
  contentTags: [],
  localEnvironments: [],
};

describe('GDPR export table coverage', () => {
  it('has a recorded decision for every table in the schema', () => {
    const decided = new Set(registeredTables());
    const undecided = SCHEMA_TABLES.filter((table) => !decided.has(table));

    expect(
      undecided,
      `${undecided.join(', ')} exist in packages/db/src/schema but are neither read by an ` +
      'Art 15 export collector nor listed in the exclusion allowlist. Add a collector in ' +
      'packages/lib/src/compliance/export/gdpr-export.ts and register it in EXPORTED_TABLES, ' +
      'or add the table to EXCLUDED_TABLES with a reason. An unregistered table holding user ' +
      'data is silently absent from every subject access request — that is exactly how ' +
      'agent_workspaces, agent_workspace_shells and ai_stream_sessions went missing.',
    ).toEqual([]);
  });

  it('registers no table the schema does not define', () => {
    const schema = new Set(SCHEMA_TABLES);
    const phantom = registeredTables().filter((table) => !schema.has(table));

    expect(
      phantom,
      `${phantom.join(', ')} are registered by the export coverage registry but no longer ` +
      'exist in packages/db/src/schema. A renamed or dropped table left in the registry ' +
      'makes the registry lie about what the export covers.',
    ).toEqual([]);
  });

  it('never lists a table as both exported and excluded', () => {
    const both = Object.keys(EXPORTED_TABLES).filter((table) => table in EXCLUDED_TABLES);
    expect(both, `${both.join(', ')} are both exported and excluded`).toEqual([]);
  });

  it('states a substantive reason for every excluded table', () => {
    for (const [table, reason] of Object.entries(EXCLUDED_TABLES)) {
      expect(
        reason.trim().length,
        `${table} is left out of the Art 15 export with no real stated reason. ` +
        'The reason has to survive being read by a regulator, not just by us.',
      ).toBeGreaterThan(40);
    }
  });

  it('maps every exported table onto a real export category', () => {
    const categories = new Set(Object.keys(EMPTY));
    for (const [table, category] of Object.entries(EXPORTED_TABLES)) {
      expect(
        categories.has(category),
        `${table} claims to land in the "${category}" category, which is not a key of AllUserData`,
      ).toBe(true);
    }
  });

  it('ships a bundle file for every category a table is registered against', () => {
    // Closes the second half of the loop: a collector can exist, be registered
    // here, and still never reach the archive because nothing added it to
    // `buildNativeExportFiles`. Only `personalization` is legitimately absent
    // from an empty bundle — it is omitted when the user has none.
    const shipped = new Set(buildNativeExportFiles(EMPTY).map((file) => file.name));
    /** category → the bundle file it is written to. `null` = legitimately omitted from an empty bundle. */
    const FILE_FOR_CATEGORY: Record<keyof AllUserData, string | null> = {
      profile: 'profile.json',
      drives: 'drives.json',
      pages: 'pages.json',
      sheets: 'sheets.json',
      messages: 'messages.json',
      files: 'files-metadata.json',
      activity: 'activity.json',
      systemLogs: 'system-logs.json',
      apiMetrics: 'api-metrics.json',
      errorLogs: 'error-logs.json',
      aiUsage: 'ai-usage.json',
      tasks: 'tasks.json',
      sessions: 'sessions.json',
      notifications: 'notifications.json',
      displayPreferences: 'display-preferences.json',
      settings: 'settings.json',
      // Omitted entirely when the user has none, so an empty bundle lacks it.
      personalization: null,
      personalizationCandidates: 'personalization-candidates.json',
      agentWorkspaces: 'agent-workspaces.json',
      streamState: 'stream-state.json',
      localEnvironments: 'local-environments.json',
      contentTags: 'content-tags.json',
    };

    const unshipped = [...new Set(Object.values(EXPORTED_TABLES))].filter((category) => {
      const file = FILE_FOR_CATEGORY[category];
      return file !== null && !shipped.has(file);
    });

    expect(
      unshipped,
      `${unshipped.join(', ')}: a collector fills these AllUserData categories but ` +
      'buildNativeExportFiles never writes them into the archive, so they reach nobody.',
    ).toEqual([]);
  });

  it('carries the agent-session tables whose loss motivated this guard', () => {
    // Regression pins. Named individually so a future edit that quietly moves
    // one into the exclusion list fails with the table, not a set difference.
    for (const table of ['agent_workspaces', 'agent_workspace_shells', 'ai_stream_sessions']) {
      expect(Object.keys(EXPORTED_TABLES), table).toContain(table);
    }
  });

  it('reaches on Art 15 everything the Art 17 stream-state purge deletes', () => {
    // The asymmetry that made this a bug rather than a gap: `purge-stream-state`
    // deletes `ai_stream_sessions` on an erasure request. Anything we will
    // delete on demand, we must be able to disclose on demand.
    expect(EXPORTED_TABLES['ai_stream_sessions']).toBe('streamState');
    // `ai_stream_frames` is the same content in the form that replaces `parts`,
    // and `purge-stream-state` deletes it too. Pinned separately so a future
    // edit that moves it to the exclusion list has to argue with this test
    // rather than with a set difference.
    expect(EXPORTED_TABLES['ai_stream_frames']).toBe('streamState');
  });
});
