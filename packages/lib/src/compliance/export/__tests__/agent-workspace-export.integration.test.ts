/**
 * ART 15 COMPLETENESS for the agent-session tables, against a REAL Postgres.
 *
 * The epic "Agent-Session Single Source of Truth" moved a large amount of the
 * subject's actual work into `agent_workspaces`, `agent_workspace_shells` and
 * `ai_stream_sessions`, and `gdpr-export.ts` grew no collector for any of them.
 * A subject access request therefore returned LESS after the epic than before
 * it, in a product where the workspace and its shells ARE the work — while
 * ERASURE already reached all three (the `users` cascade plus the
 * `purge-stream-state` step). We were deleting on demand what we would not
 * disclose on demand. That asymmetry is the bug these tests pin closed.
 *
 * Chain-mocked unit tests could not express the thing that actually matters
 * here, which is a PREDICATE over rows belonging to two different people. So
 * this runs the shipped collectors against a real database with two real
 * subjects, and asserts both directions:
 *
 *   COMPLETENESS  — the subject's workspaces, their shells (including the cold
 *                   scrollback) and their generations' checkpointed `parts`
 *                   are all in the export.
 *   ART 15(4)     — and NOTHING belonging to the other person is, even when it
 *                   sits inside a container the subject owns.
 *
 * Requires a live `DATABASE_URL` with migrations applied. It does NOT skip when
 * one is missing: a compliance test that silently passes on an unreachable
 * database is worse than no test, because it reports green on the exact
 * question it did not ask.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { eq, inArray } from 'drizzle-orm';
import { db } from '@pagespace/db/db';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { conversations } from '@pagespace/db/schema/conversations';
import { agentWorkspaces, agentWorkspaceShells } from '@pagespace/db/schema/agent-workspaces';
import { aiStreamSessions, aiStreamFrames } from '@pagespace/db/schema/ai-streams';
import { factories } from '@pagespace/db/test/factories';
import {
  collectUserAgentWorkspaces,
  collectUserStreamState,
  type UserAgentWorkspaceExport,
} from '../gdpr-export';

type DB = Parameters<typeof collectUserAgentWorkspaces>[0];
const database = db as unknown as DB;

/** The data subject, and the other person whose rows must never travel with theirs. */
let subjectId: string;
let otherId: string;
let driveId: string;

/** The subject's own workspace, which the OTHER user also has a shell in. */
let sharedWorkspaceId: string;
/** A workspace the OTHER user owns, which the SUBJECT has a shell in. */
let foreignWorkspaceId: string;
/** A conversation the subject owns, in the subject's workspace. */
let subjectConversationId: string;
/** The subject's own generation, and the other human's inside the subject's thread. */
let subjectMessageId: string;
let otherMessageId: string;

const SUBJECT_SHELL_TAIL = 'subject scrollback: cargo build --release';
const OTHER_SHELL_TAIL = 'other-person scrollback: DO NOT EXPORT';
const SUBJECT_PARTS = [{ type: 'text', text: 'the subject asked, the agent answered' }];
const AGENT_PARTS = [{ type: 'text', text: 'dispatched worker output in the subject thread' }];
const OTHER_PARTS = [{ type: 'text', text: 'another human generation — DO NOT EXPORT' }];

/**
 * The frame log for the subject's generation, split across two batch rows and
 * INSERTED tail-first, so the collector's ordering is doing real work: reading
 * these back in insertion order would fail.
 */
const SUBJECT_FRAMES_HEAD = [
  { type: 'text-start', id: 't1' },
  { type: 'text-delta', id: 't1', delta: 'raw frames the subject ' },
];
const SUBJECT_FRAMES_TAIL = [
  { type: 'text-delta', id: 't1', delta: 'generated' },
  { type: 'text-end', id: 't1' },
];
const OTHER_FRAMES = [{ type: 'text-delta', id: 'x1', delta: 'another human\'s frames — DO NOT EXPORT' }];

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      'agent-workspace-export.integration.test.ts needs a live DATABASE_URL. It refuses to ' +
      'skip: an Art 15 completeness test that passes without asking the database has not ' +
      'checked anything.',
    );
  }

  const subject = await factories.createUser();
  const other = await factories.createUser();
  subjectId = subject.id;
  otherId = other.id;
  const drive = await factories.createDrive(subjectId);
  driveId = drive.id;

  sharedWorkspaceId = createId();
  foreignWorkspaceId = createId();
  await db.insert(agentWorkspaces).values([
    {
      id: sharedWorkspaceId,
      driveId,
      ownerId: subjectId,
      name: 'the subject working context',
      lastActiveAt: new Date('2026-01-02T00:00:00Z'),
      // Sprite identity — must be stripped from the export: it names a VM in
      // OUR fleet, not anything about the subject.
      spriteKey: 'sprite-key-never-exported',
      sandboxId: 'sandbox-never-exported',
      spriteInstanceId: 'instance-never-exported',
      egressPolicyToken: 'egress-never-exported',
      storageMeasuredBytes: 4096,
      storageMeasuredAt: new Date('2026-01-02T00:00:00Z'),
      updatedAt: new Date(),
    },
    {
      id: foreignWorkspaceId,
      driveId,
      ownerId: otherId,
      name: 'someone else\'s working context',
      updatedAt: new Date(),
    },
  ]);

  await db.insert(agentWorkspaceShells).values([
    // The subject's own shell in their own workspace.
    {
      id: createId(),
      workspaceId: sharedWorkspaceId,
      ownerId: subjectId,
      name: 'subject-shell',
      agentType: 'shell',
      command: 'bash -l',
      coldTail: SUBJECT_SHELL_TAIL,
      coldTailAt: new Date('2026-01-03T00:00:00Z'),
      coldTailHasOutput: true,
      spriteExecId: 'exec-never-exported',
      updatedAt: new Date(),
    },
    // ANOTHER PERSON's shell inside the subject's OWN workspace (Art 15(4)).
    {
      id: createId(),
      workspaceId: sharedWorkspaceId,
      ownerId: otherId,
      name: 'other-shell',
      agentType: 'shell',
      coldTail: OTHER_SHELL_TAIL,
      coldTailHasOutput: true,
      updatedAt: new Date(),
    },
    // The subject's shell inside SOMEONE ELSE's workspace — still theirs.
    {
      id: createId(),
      workspaceId: foreignWorkspaceId,
      ownerId: subjectId,
      name: 'subject-shell-abroad',
      agentType: 'shell',
      coldTail: 'subject scrollback in a foreign workspace',
      coldTailHasOutput: true,
      updatedAt: new Date(),
    },
  ]);

  subjectConversationId = createId();
  const otherConversationId = createId();
  await db.insert(conversations).values([
    {
      id: subjectConversationId,
      userId: subjectId,
      type: 'global',
      title: 'subject thread',
    },
    {
      id: otherConversationId,
      userId: otherId,
      type: 'global',
      title: 'other thread',
    },
  ]);

  subjectMessageId = createId();
  otherMessageId = createId();

  await db.insert(aiStreamSessions).values([
    // Leg 1: triggered by the subject, in their own thread.
    {
      messageId: subjectMessageId,
      channelId: `conversation:${subjectConversationId}`,
      conversationId: subjectConversationId,
      userId: subjectId,
      parts: SUBJECT_PARTS,
      status: 'complete',
    },
    // Leg 2: NO human trigger (a service/agent actor id that matches no `users`
    // row — a dispatched worker), inside the SUBJECT's own conversation. This
    // is the exact shape of the Art 15 hole the epic already closed for
    // `messages`: the agent side of the subject's thread must not vanish.
    {
      messageId: createId(),
      channelId: `conversation:${subjectConversationId}`,
      conversationId: subjectConversationId,
      userId: `agent-actor-${createId()}`,
      parts: AGENT_PARTS,
      status: 'complete',
    },
    // ANOTHER HUMAN's generation inside the subject's own conversation —
    // that person's content, and Art 15(4) keeps it out.
    {
      messageId: otherMessageId,
      channelId: `conversation:${subjectConversationId}`,
      conversationId: subjectConversationId,
      userId: otherId,
      parts: OTHER_PARTS,
      status: 'complete',
    },
    // The other person's generation in their own thread — never the subject's.
    {
      messageId: createId(),
      channelId: `conversation:${otherConversationId}`,
      conversationId: otherConversationId,
      userId: otherId,
      parts: OTHER_PARTS,
      status: 'complete',
    },
  ]);

  // The frame log for two of those generations. Batched across two rows for the
  // subject's, because the flattening — order by `from_seq`, concatenate — is
  // the part of the collector that a single-row fixture could not catch.
  await db.insert(aiStreamFrames).values([
    {
      messageId: subjectMessageId,
      conversationId: subjectConversationId,
      fromSeq: 2,
      frameCount: SUBJECT_FRAMES_TAIL.length,
      frames: SUBJECT_FRAMES_TAIL,
      byteSize: JSON.stringify(SUBJECT_FRAMES_TAIL).length,
    },
    {
      messageId: subjectMessageId,
      conversationId: subjectConversationId,
      fromSeq: 0,
      frameCount: SUBJECT_FRAMES_HEAD.length,
      frames: SUBJECT_FRAMES_HEAD,
      byteSize: JSON.stringify(SUBJECT_FRAMES_HEAD).length,
    },
    // The other human's frames, inside the SUBJECT's conversation. The cascade
    // key would reach them; the session row's `user_id` is what must not.
    {
      messageId: otherMessageId,
      conversationId: subjectConversationId,
      fromSeq: 0,
      frameCount: OTHER_FRAMES.length,
      frames: OTHER_FRAMES,
      byteSize: JSON.stringify(OTHER_FRAMES).length,
    },
  ]);
});

afterAll(async () => {
  // Deleting the users cascades to drives, workspaces, shells, conversations
  // and (via 0250) the stream rows bound to those conversations. The stream
  // rows carrying a service actor id are not reached by any cascade, so they
  // are removed explicitly.
  const ids = [subjectId, otherId].filter(Boolean);
  if (ids.length === 0) return;
  const orphanConversations = [subjectConversationId].filter(Boolean);
  if (orphanConversations.length > 0) {
    await db.delete(aiStreamFrames).where(inArray(aiStreamFrames.conversationId, orphanConversations));
    await db.delete(aiStreamSessions).where(inArray(aiStreamSessions.conversationId, orphanConversations));
  }
  await db.delete(users).where(inArray(users.id, ids));
  await db.delete(drives).where(eq(drives.id, driveId));
});

const workspaceById = (rows: UserAgentWorkspaceExport[], id: string) =>
  rows.find((row) => row.id === id);

describe('collectUserAgentWorkspaces (Art 15 completeness)', () => {
  it('carries the subject\'s workspace and their own shell inside it', async () => {
    const rows = await collectUserAgentWorkspaces(database, subjectId);

    const own = workspaceById(rows, sharedWorkspaceId);
    expect(own, 'the subject\'s own workspace is missing from their export').toBeDefined();
    expect(own!.role).toBe('owner');
    expect(own!.name).toBe('the subject working context');
    expect(own!.driveId).toBe(driveId);

    const shellNames = own!.shells.map((s) => s.name);
    expect(shellNames).toContain('subject-shell');
    const shell = own!.shells.find((s) => s.name === 'subject-shell')!;
    // The scrollback IS the work. A shell row without it is an empty label.
    expect(shell.coldTail).toBe(SUBJECT_SHELL_TAIL);
    expect(shell.coldTailHasOutput).toBe(true);
    expect(shell.command).toBe('bash -l');
  });

  it('withholds ANOTHER member\'s shell from the subject\'s own workspace (Art 15(4))', async () => {
    const rows = await collectUserAgentWorkspaces(database, subjectId);
    const own = workspaceById(rows, sharedWorkspaceId)!;

    expect(own.shells.map((s) => s.name)).not.toContain('other-shell');
    expect(JSON.stringify(rows)).not.toContain(OTHER_SHELL_TAIL);
  });

  it('carries the subject\'s shell in SOMEONE ELSE\'s workspace, without that workspace\'s details', async () => {
    const rows = await collectUserAgentWorkspaces(database, subjectId);

    const foreign = workspaceById(rows, foreignWorkspaceId);
    expect(foreign, 'a subject-owned shell abroad was dropped entirely').toBeDefined();
    expect(foreign!.role).toBe('participant');
    expect(foreign!.shells.map((s) => s.name)).toEqual(['subject-shell-abroad']);
    // The host workspace is the OTHER person's working context; naming it
    // would disclose their data (Art 15(4)).
    expect(foreign!.name).toBeNull();
    expect(foreign!.driveId).toBeNull();
    expect(foreign!.createdAt).toBeNull();
    expect(JSON.stringify(rows)).not.toContain('someone else\'s working context');
  });

  it('strips the Sprite identity and storage accounting — our fleet, not their data', async () => {
    const rows = await collectUserAgentWorkspaces(database, subjectId);
    const serialized = JSON.stringify(rows);

    for (const secret of [
      'sprite-key-never-exported',
      'sandbox-never-exported',
      'instance-never-exported',
      'egress-never-exported',
      'exec-never-exported',
    ]) {
      expect(serialized, `${secret} leaked into the subject access export`).not.toContain(secret);
    }
    const own = workspaceById(rows, sharedWorkspaceId)!;
    expect(Object.keys(own)).not.toContain('storageMeasuredBytes');
  });

  it('returns nothing for a user with no workspaces at all', async () => {
    const stranger = await factories.createUser();
    try {
      expect(await collectUserAgentWorkspaces(database, stranger.id)).toEqual([]);
    } finally {
      await db.delete(users).where(eq(users.id, stranger.id));
    }
  });
});

describe('collectUserStreamState (Art 15 completeness)', () => {
  it('carries generations the subject triggered', async () => {
    const rows = await collectUserStreamState(database, subjectId);
    expect(rows.map((r) => r.parts)).toContainEqual(SUBJECT_PARTS);
  });

  it('carries the AGENT side of the subject\'s own thread — the leg that has no human author', async () => {
    const rows = await collectUserStreamState(database, subjectId);
    expect(
      rows.map((r) => r.parts),
      'a dispatched worker\'s checkpointed output inside the subject\'s own conversation was ' +
      'dropped — the same Art 15 hole the epic already closed for `messages`',
    ).toContainEqual(AGENT_PARTS);
  });

  it('withholds ANOTHER human\'s generation from inside the subject\'s conversation (Art 15(4))', async () => {
    const rows = await collectUserStreamState(database, subjectId);
    expect(JSON.stringify(rows)).not.toContain('DO NOT EXPORT');
  });

  it('carries the durable FRAME LOG, flattened into seq order across batch rows', async () => {
    // The successor to `parts`, and the only copy of a generation that was
    // interrupted before its assistant row materialized. Rows are inserted
    // tail-first, so an unordered read returns the reply backwards.
    const rows = await collectUserStreamState(database, subjectId);
    const subjectRow = rows.find((r) => r.messageId === subjectMessageId);

    expect(subjectRow, 'the subject\'s own generation was dropped').toBeDefined();
    expect(subjectRow!.frames).toEqual([...SUBJECT_FRAMES_HEAD, ...SUBJECT_FRAMES_TAIL]);
  });

  it('withholds ANOTHER human\'s frames even though they sit in the subject\'s conversation', async () => {
    // The frame log has no `user_id` — only the session row knows whose content
    // it is. Reaching frames by conversation instead of by the sessions this
    // collector already filtered would disclose the other person's generation.
    const rows = await collectUserStreamState(database, subjectId);
    expect(rows.map((r) => r.messageId)).not.toContain(otherMessageId);
    expect(JSON.stringify(rows.map((r) => r.frames))).not.toContain('DO NOT EXPORT');
  });

  it('returns an empty frame array for a generation with no frame log', async () => {
    // Every generation until the frame-log writer lands, and every one whose
    // frames the retention sweep already took. Must not be undefined: the
    // bundle is serialized straight to JSON.
    const rows = await collectUserStreamState(database, subjectId);
    const unframed = rows.filter((r) => r.messageId !== subjectMessageId);

    expect(unframed.length).toBeGreaterThan(0);
    for (const row of unframed) expect(row.frames).toEqual([]);
  });

  it('strips stream transport plumbing, keeping only the content and its lifecycle', async () => {
    const [row] = await collectUserStreamState(database, subjectId);
    expect(row).toBeDefined();
    expect(Object.keys(row).sort()).toEqual(
      ['completedAt', 'conversationId', 'frames', 'messageId', 'parts', 'startedAt', 'status'],
    );
  });

  it('returns nothing for a user who has never streamed', async () => {
    const stranger = await factories.createUser();
    try {
      expect(await collectUserStreamState(database, stranger.id)).toEqual([]);
    } finally {
      await db.delete(users).where(eq(users.id, stranger.id));
    }
  });
});
