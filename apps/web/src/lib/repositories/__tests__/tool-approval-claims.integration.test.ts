import { describe, it, beforeAll, beforeEach, afterAll } from 'vitest';
import { assert } from '@/lib/ai/core/__tests__/riteway';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { conversations } from '@pagespace/db/schema/conversations';
import { users } from '@pagespace/db/schema/auth';
import { aiToolApprovalDecisions } from '@pagespace/db/schema/tool-approvals';
import { ensureTestDb } from '@/test/ensure-test-db';
import { toolApprovalRepository } from '../tool-approval-repository';
import { withAssistantMessageLock } from '@/lib/ai/core/assistant-message-lock';

/**
 * THE REAL DATABASE, DELIBERATELY. The unit suite pins the SHAPE of each claim
 * (`ON CONFLICT DO NOTHING`, `WHERE outcome IS NULL … RETURNING`); only Postgres
 * can show that concurrent callers actually resolve to one winner, and that the
 * per-message lock really serializes writers across connections.
 */

const USER_ID = 'tool-approval-claims-it-user';
const CONVERSATION_ID = 'tool-approval-claims-it-conv';

const claim = (approvalId: string, approved: boolean) =>
  toolApprovalRepository.claimDecision({
    approvalId,
    toolCallId: `tc-${approvalId}`,
    toolName: 'trash_page',
    messageId: 'msg-claims-it',
    conversationId: CONVERSATION_ID,
    userId: USER_ID,
    approved,
    reason: approved ? null : 'no',
    scope: approved ? 'once' : null,
  });

const outcomeOf = async (approvalId: string) => {
  const [row] = await db
    .select({ outcome: aiToolApprovalDecisions.outcome })
    .from(aiToolApprovalDecisions)
    .where(eq(aiToolApprovalDecisions.approvalId, approvalId));
  return row?.outcome ?? null;
};

beforeAll(async () => {
  await ensureTestDb();
  await db
    .insert(users)
    .values({ id: USER_ID, name: 'Approval Claims IT', email: 'approval-claims-it@example.test' } as never)
    .onConflictDoNothing();
  await db
    .insert(conversations)
    .values({ id: CONVERSATION_ID, userId: USER_ID, type: 'global' } as never)
    .onConflictDoNothing();
});

afterAll(async () => {
  // CASCADE takes the decision rows with it.
  await db.delete(conversations).where(eq(conversations.id, CONVERSATION_ID));
  await db.delete(users).where(eq(users.id, USER_ID));
});

beforeEach(async () => {
  await db.delete(aiToolApprovalDecisions).where(eq(aiToolApprovalDecisions.conversationId, CONVERSATION_ID));
});

describe('decision claims under real concurrency', () => {
  it('given ten tabs answering the same card at once, exactly one claim wins', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => claim('ap-race', i % 2 === 0)));
    assert({
      given: 'ten concurrent claimDecision calls for one approval id',
      should: 'return exactly one winner',
      actual: results.filter((r) => r !== null).length,
      expected: 1,
    });
  });

  it('given an execution start racing a stale-close, exactly one wins and the row records it', async () => {
    const tally = { running: 0, stale: 0 };
    for (let i = 0; i < 20; i += 1) {
      const approvalId = `ap-start-vs-stale-${i}`;
      await claim(approvalId, true);
      const [started, staled] = await Promise.all([
        toolApprovalRepository.claimExecutionStart(approvalId),
        toolApprovalRepository.claimStale(approvalId),
      ]);
      if (started === staled) throw new Error(`both or neither won for ${approvalId}`);
      const outcome = await outcomeOf(approvalId);
      if (started && outcome === 'running') tally.running += 1;
      if (staled && outcome === 'stale') tally.stale += 1;
    }
    assert({
      given: 'twenty start-vs-stale races',
      should: 'resolve every one to a single recorded winner',
      actual: tally.running + tally.stale,
      expected: 20,
    });
  });

  it('given a call that ran after being closed as stale, its real result overwrites stale', async () => {
    await claim('ap-truth', true);
    await toolApprovalRepository.claimStale('ap-truth');
    const won = await toolApprovalRepository.recordOutcome('ap-truth', 'ok');
    assert({
      given: 'a stale row and a late real result',
      should: 'record ok',
      actual: { won, outcome: await outcomeOf('ap-truth') },
      expected: { won: true, outcome: 'ok' },
    });
  });

  it('given a denial, the execution start loses and getDecision reports what was decided', async () => {
    await claim('ap-denied', false);
    await toolApprovalRepository.markExecuted('ap-denied', 'denied');
    assert({
      given: 'a denied decision',
      should: 'refuse to start and read back approved=false with its reason',
      actual: {
        started: await toolApprovalRepository.claimExecutionStart('ap-denied'),
        decision: await toolApprovalRepository.getDecision('ap-denied'),
      },
      expected: { started: false, decision: { approved: false, reason: 'no' } },
    });
  });
});

describe('withAssistantMessageLock on a real advisory lock', () => {
  it('serializes read-modify-write writers on one message: no update is lost', async () => {
    let shared = 0;
    const writer = () =>
      withAssistantMessageLock('msg-lock-it', async () => {
        const read = shared;
        await new Promise((resolve) => setTimeout(resolve, 20));
        shared = read + 1;
      });
    await Promise.all(Array.from({ length: 5 }, writer));
    assert({
      given: 'five concurrent read-modify-write writers on one message',
      should: 'apply all five',
      actual: shared,
      expected: 5,
    });
  });
});
