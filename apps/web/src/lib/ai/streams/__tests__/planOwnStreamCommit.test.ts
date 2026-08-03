import { describe, it, expect } from 'vitest';
import type { UIMessage } from 'ai';
import { planOwnStreamCommit, type PlanOwnStreamCommitInput } from '../planOwnStreamCommit';

const makeInput = (overrides: Partial<PlanOwnStreamCommitInput> = {}): PlanOwnStreamCommitInput => ({
  message: {
    id: 'msg-1',
    role: 'assistant',
    parts: [{ type: 'text', text: 'the reply' }] as UIMessage['parts'],
  },
  isAbort: false,
  isDisconnect: false,
  isError: false,
  startedAt: undefined,
  ...overrides,
});

describe('planOwnStreamCommit', () => {
  it('given a clean finish with parts, should commit with status complete', () => {
    const plan = planOwnStreamCommit(makeInput());
    expect(plan).not.toBeNull();
    expect(plan!.message.id).toBe('msg-1');
    expect(plan!.message.parts).toEqual([{ type: 'text', text: 'the reply' }]);
    expect((plan!.message as UIMessage & { status?: string }).status).toBe('complete');
  });

  it('given a local abort with partial parts, should commit with status interrupted', () => {
    const plan = planOwnStreamCommit(makeInput({ isAbort: true }));
    expect(plan).not.toBeNull();
    expect((plan!.message as UIMessage & { status?: string }).status).toBe('interrupted');
  });

  it('given an abort with zero parts, should not commit (reload path owns it)', () => {
    const plan = planOwnStreamCommit(
      makeInput({ isAbort: true, message: { id: 'msg-1', role: 'assistant', parts: [] } }),
    );
    expect(plan).toBeNull();
  });

  it('given an error finish, should not commit (persistence not proven)', () => {
    expect(planOwnStreamCommit(makeInput({ isError: true }))).toBeNull();
  });

  it('given a network disconnect, should not commit', () => {
    expect(planOwnStreamCommit(makeInput({ isDisconnect: true }))).toBeNull();
  });

  it('given an abort that is ALSO an error, should not commit (error wins)', () => {
    expect(planOwnStreamCommit(makeInput({ isAbort: true, isError: true }))).toBeNull();
  });

  it('given a non-assistant message, should not commit', () => {
    const plan = planOwnStreamCommit(
      makeInput({
        message: { id: 'msg-1', role: 'user', parts: [{ type: 'text', text: 'hi' }] as UIMessage['parts'] },
      }),
    );
    expect(plan).toBeNull();
  });

  it('given a clean finish with zero parts, should not commit', () => {
    const plan = planOwnStreamCommit(makeInput({ message: { id: 'msg-1', role: 'assistant', parts: [] } }));
    expect(plan).toBeNull();
  });

  it('given a startedAt, should thread it into the committed message createdAt', () => {
    const plan = planOwnStreamCommit(makeInput({ startedAt: '2026-08-03T12:00:00.000Z' }));
    expect((plan!.message as UIMessage & { createdAt?: Date }).createdAt).toEqual(
      new Date('2026-08-03T12:00:00.000Z'),
    );
  });

  it('given no startedAt, should omit createdAt entirely', () => {
    const plan = planOwnStreamCommit(makeInput());
    expect(plan!.message).not.toHaveProperty('createdAt');
  });

  it('given the input parts array, should not share it with the committed message (purity)', () => {
    const parts = [{ type: 'text', text: 'the reply' }] as UIMessage['parts'];
    const plan = planOwnStreamCommit(makeInput({ message: { id: 'msg-1', role: 'assistant', parts } }));
    expect(plan!.message.parts).not.toBe(parts);
    expect(plan!.message.parts).toEqual(parts);
  });
});
