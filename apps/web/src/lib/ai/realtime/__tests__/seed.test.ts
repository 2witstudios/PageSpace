import { describe, expect, it } from 'vitest';
import {
  buildRealtimeSeed,
  DEFAULT_SEED_MAX_TOKENS,
  DEFAULT_SEED_MAX_TURNS,
  estimateSeedTokens,
  SEED_CHARS_PER_TOKEN,
  type SeedEvent,
  type SeedMessage,
} from '../seed';

/** A message `n` minutes into the conversation, so ordering is explicit. */
const at = (minute: number): Date => new Date(Date.UTC(2026, 0, 1, 0, minute, 0));

const msg = (over: Partial<SeedMessage> = {}): SeedMessage => ({
  role: 'user',
  content: 'hello',
  createdAt: at(0),
  ...over,
});

/** The text of every emitted item, in emitted order. */
const texts = (events: readonly SeedEvent[]): string[] =>
  events.map((event) => event.item.content[0].text);

const roles = (events: readonly SeedEvent[]): string[] =>
  events.map((event) => event.item.role);

/** `maxTokens` tokens' worth of a single repeated word, for budget arithmetic. */
const wordsWorth = (tokens: number): string =>
  'x'.repeat(tokens * SEED_CHARS_PER_TOKEN);

describe('estimateSeedTokens', () => {
  it('given text, should estimate at four characters per token', () => {
    expect(estimateSeedTokens('12345678')).toBe(2);
  });

  it('given a partial token, should round up rather than lose it', () => {
    expect(estimateSeedTokens('123')).toBe(1);
  });

  it('given an empty string, should estimate nothing', () => {
    expect(estimateSeedTokens('')).toBe(0);
  });
});

describe('buildRealtimeSeed', () => {
  it('given an empty message list, should return an empty array', () => {
    expect(buildRealtimeSeed([])).toEqual([]);
  });

  it('given only unseedable messages, should return an empty array', () => {
    expect(
      buildRealtimeSeed([
        msg({ role: 'system', content: 'You are helpful.' }),
        msg({ content: '   ' }),
      ]),
    ).toEqual([]);
  });

  it('given a user message, should emit a conversation.item.create with input_text', () => {
    expect(buildRealtimeSeed([msg({ role: 'user', content: 'where are my notes?' })])).toEqual([
      {
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'where are my notes?' }],
        },
      },
    ]);
  });

  it('given an assistant message, should emit it as TEXT content, never audio', () => {
    const [event] = buildRealtimeSeed([msg({ role: 'assistant', content: 'In your Inbox.' })]);

    expect(event).toEqual({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'In your Inbox.' }],
      },
    });
    // The failure this guards is silent: an `input_audio`/`input_text` part on
    // an assistant item is rejected as an opaque error event, not a message.
    expect(JSON.stringify(event)).not.toContain('audio');
    expect(JSON.stringify(event)).not.toContain('input_text');
  });

  it('given both sides of an exchange, should emit user AND assistant turns', () => {
    const events = buildRealtimeSeed([
      msg({ role: 'user', content: 'hi', createdAt: at(1) }),
      msg({ role: 'assistant', content: 'hello', createdAt: at(2) }),
    ]);

    expect(roles(events)).toEqual(['user', 'assistant']);
  });

  it('given a system message among real turns, should skip it', () => {
    const events = buildRealtimeSeed([
      msg({ role: 'user', content: 'hi', createdAt: at(1) }),
      msg({ role: 'system', content: 'You are helpful.', createdAt: at(2) }),
      msg({ role: 'assistant', content: 'hello', createdAt: at(3) }),
    ]);

    expect(texts(events)).toEqual(['hi', 'hello']);
  });

  it('given a message with empty or whitespace-only content, should skip it rather than emit an empty item', () => {
    const events = buildRealtimeSeed([
      msg({ content: '', createdAt: at(1) }),
      msg({ content: '   \n\t ', createdAt: at(2) }),
      msg({ content: 'real', createdAt: at(3) }),
    ]);

    expect(texts(events)).toEqual(['real']);
  });

  it('given content with surrounding whitespace, should emit it trimmed', () => {
    expect(texts(buildRealtimeSeed([msg({ content: '  spaced  ' })]))).toEqual(['spaced']);
  });

  it('given messages out of chronological order, should emit in chronological order', () => {
    const events = buildRealtimeSeed([
      msg({ content: 'third', createdAt: at(3) }),
      msg({ content: 'first', createdAt: at(1) }),
      msg({ content: 'second', createdAt: at(2) }),
    ]);

    expect(texts(events)).toEqual(['first', 'second', 'third']);
  });

  it('given messages with identical timestamps, should keep their input order', () => {
    const events = buildRealtimeSeed([
      msg({ content: 'a', createdAt: at(1) }),
      msg({ content: 'b', createdAt: at(1) }),
    ]);

    expect(texts(events)).toEqual(['a', 'b']);
  });

  it('given a string or numeric createdAt, should order by it', () => {
    const events = buildRealtimeSeed([
      msg({ content: 'later', createdAt: at(5).toISOString() }),
      msg({ content: 'earlier', createdAt: at(1).getTime() }),
    ]);

    expect(texts(events)).toEqual(['earlier', 'later']);
  });

  it('given a missing or unparseable createdAt, should sort it oldest instead of dropping it', () => {
    const events = buildRealtimeSeed([
      msg({ content: 'dated', createdAt: at(1) }),
      msg({ content: 'undated', createdAt: undefined }),
      msg({ content: 'null-dated', createdAt: null }),
      msg({ content: 'garbage-dated', createdAt: 'not a date' }),
    ]);

    expect(texts(events)).toEqual(['undated', 'null-dated', 'garbage-dated', 'dated']);
  });

  describe('the turn cap', () => {
    it('given a conversation with 100 messages, should emit at most the cap and keep the most recent', () => {
      const hundred = Array.from({ length: 100 }, (_, index) =>
        msg({ content: `m${index}`, createdAt: at(index) }),
      );

      const events = buildRealtimeSeed(hundred);

      expect(events).toHaveLength(DEFAULT_SEED_MAX_TURNS);
      expect(texts(events)[0]).toBe(`m${100 - DEFAULT_SEED_MAX_TURNS}`);
      expect(texts(events).at(-1)).toBe('m99');
    });

    it('given a configured turn cap, should honour it over the default', () => {
      const ten = Array.from({ length: 10 }, (_, index) =>
        msg({ content: `m${index}`, createdAt: at(index) }),
      );

      expect(texts(buildRealtimeSeed(ten, { maxTurns: 3 }))).toEqual(['m7', 'm8', 'm9']);
    });

    it('given fewer messages than the cap, should emit all of them', () => {
      const three = Array.from({ length: 3 }, (_, index) =>
        msg({ content: `m${index}`, createdAt: at(index) }),
      );

      expect(buildRealtimeSeed(three)).toHaveLength(3);
    });

    it('given a non-positive turn cap, should seed nothing', () => {
      expect(buildRealtimeSeed([msg()], { maxTurns: 0 })).toEqual([]);
    });
  });

  describe('the token budget', () => {
    it('given messages exceeding the token budget, should drop oldest-first even when the turn count is already under its cap', () => {
      // Three turns — well under DEFAULT_SEED_MAX_TURNS — but 300 tokens
      // against a 250 budget, so exactly one has to go, and it is the oldest.
      const events = buildRealtimeSeed(
        [
          msg({ content: `old ${wordsWorth(100)}`, createdAt: at(1) }),
          msg({ content: `mid ${wordsWorth(100)}`, createdAt: at(2) }),
          msg({ content: `new ${wordsWorth(100)}`, createdAt: at(3) }),
        ],
        { maxTokens: 250 },
      );

      expect(events).toHaveLength(2);
      expect(texts(events)[0]).toContain('mid');
      expect(texts(events)[1]).toContain('new');
    });

    it('given a budget that only fits the newest turn, should keep exactly that turn', () => {
      const events = buildRealtimeSeed(
        [
          msg({ content: `old ${wordsWorth(100)}`, createdAt: at(1) }),
          msg({ content: `new ${wordsWorth(100)}`, createdAt: at(2) }),
        ],
        { maxTokens: 120 },
      );

      expect(events).toHaveLength(1);
      expect(texts(events)[0]).toContain('new');
    });

    it('given every turn inside the budget, should drop nothing', () => {
      const events = buildRealtimeSeed(
        [
          msg({ content: 'short', createdAt: at(1) }),
          msg({ content: 'also short', createdAt: at(2) }),
        ],
        { maxTokens: DEFAULT_SEED_MAX_TOKENS },
      );

      expect(events).toHaveLength(2);
    });

    it('given a single most-recent turn larger than the whole budget, should truncate it rather than return nothing', () => {
      const events = buildRealtimeSeed(
        [msg({ content: `${wordsWorth(500)} tail`, createdAt: at(1) })],
        { maxTokens: 50 },
      );

      expect(events).toHaveLength(1);
      const [text] = texts(events);
      expect(estimateSeedTokens(text)).toBeLessThanOrEqual(50 + 12);
      expect(text).toContain('earlier part of this message omitted');
    });

    it('given a long final turn after older ones, should drop the older ones AND truncate it', () => {
      const events = buildRealtimeSeed(
        [
          msg({ content: 'old chatter', createdAt: at(1) }),
          msg({ content: `${wordsWorth(500)} tail`, createdAt: at(2) }),
        ],
        { maxTokens: 50 },
      );

      expect(events).toHaveLength(1);
      expect(texts(events)[0]).toContain('earlier part of this message omitted');
    });

    it('given truncation mid-sentence, should cut at a word boundary rather than sever a word', () => {
      // 200 chars of "alpha beta " against a 10-token (40-char) budget, so the
      // cut lands inside a word unless the boundary logic moves it back.
      const events = buildRealtimeSeed(
        [msg({ content: 'alpha beta '.repeat(40), createdAt: at(1) })],
        { maxTokens: 10 },
      );

      const [text] = texts(events);
      expect(text).toBe('alpha beta alpha beta alpha beta alpha… (earlier part of this message omitted)');
    });

    it('given truncation with no word boundary to cut on, should still fit the budget', () => {
      const events = buildRealtimeSeed(
        [msg({ content: 'y'.repeat(1000), createdAt: at(1) })],
        { maxTokens: 10 },
      );

      expect(texts(events)[0].startsWith('y'.repeat(40))).toBe(true);
      expect(texts(events)[0]).toContain('earlier part of this message omitted');
    });

    it('given a non-positive token budget, should seed nothing', () => {
      expect(buildRealtimeSeed([msg()], { maxTokens: 0 })).toEqual([]);
    });

    it('given the defaults, should apply both caps together', () => {
      // Each turn is a quarter of the default budget, so the token budget binds
      // long before the turn cap does: 4 turns fit, the 5th does not.
      const many = Array.from({ length: DEFAULT_SEED_MAX_TURNS }, (_, index) =>
        msg({ content: `${index} ${wordsWorth(DEFAULT_SEED_MAX_TOKENS / 4)}`, createdAt: at(index) }),
      );

      const events = buildRealtimeSeed(many);

      expect(events.length).toBeLessThan(DEFAULT_SEED_MAX_TURNS);
      const total = texts(events).reduce((sum, text) => sum + estimateSeedTokens(text), 0);
      expect(total).toBeLessThanOrEqual(DEFAULT_SEED_MAX_TOKENS);
    });
  });
});
