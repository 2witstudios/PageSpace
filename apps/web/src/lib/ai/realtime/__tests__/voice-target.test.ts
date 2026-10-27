import { describe, expect, it } from 'vitest';
import { decideBind, sameVoiceTarget, type VoiceTarget } from '../voice-target';

const GLOBAL: VoiceTarget = { conversationId: 'conv-1', type: 'global' };
const PAGE: VoiceTarget = {
  conversationId: 'conv-2',
  type: 'page',
  contextId: 'page-1',
  agentPageId: 'agent-1',
};

describe('sameVoiceTarget', () => {
  it('given two targets with identical fields, should call them the same binding', () => {
    expect(sameVoiceTarget(PAGE, { ...PAGE })).toBe(true);
  });

  it('given a different conversation, should call it a different binding', () => {
    expect(sameVoiceTarget(GLOBAL, { ...GLOBAL, conversationId: 'conv-9' })).toBe(
      false,
    );
  });

  it('given the same conversation under a different agent, should call it a different binding', () => {
    // The switcher can move agents while a conversation id is still resolving;
    // matching on conversationId alone would keep talking to the old agent.
    expect(sameVoiceTarget(PAGE, { ...PAGE, agentPageId: 'agent-2' })).toBe(
      false,
    );
  });

  it('given the same conversation in a different context, should call it a different binding', () => {
    expect(sameVoiceTarget(PAGE, { ...PAGE, contextId: 'page-9' })).toBe(false);
    expect(sameVoiceTarget(PAGE, { ...PAGE, type: 'drive' })).toBe(false);
  });

  it('given two unbound sessions, should call them the same', () => {
    expect(sameVoiceTarget(null, null)).toBe(true);
  });

  it('given one unbound session, should call it different', () => {
    expect(sameVoiceTarget(null, GLOBAL)).toBe(false);
    expect(sameVoiceTarget(GLOBAL, null)).toBe(false);
  });
});

describe('decideBind', () => {
  it('given nothing bound, should start', () => {
    expect(decideBind(null, GLOBAL)).toBe('start');
  });

  it('given the target already bound, should do nothing', () => {
    // A second press, or a re-render handing back the same target, must not
    // restart a call mid-sentence.
    expect(decideBind(GLOBAL, { ...GLOBAL })).toBe('none');
  });

  it('given a deliberately different agent, should rebind', () => {
    expect(decideBind(PAGE, { ...PAGE, agentPageId: 'agent-2' })).toBe('rebind');
  });

  it('given a different conversation, should rebind', () => {
    expect(decideBind(GLOBAL, PAGE)).toBe('rebind');
  });
});
