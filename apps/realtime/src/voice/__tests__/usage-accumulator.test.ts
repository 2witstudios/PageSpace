import { describe, it, expect } from 'vitest';
import { calculateRealtimeCostDollars } from '@pagespace/lib/monitoring/voice-pricing';
import type { RealtimeUsage } from '@pagespace/lib/monitoring/voice-pricing';
import { addUsage, hasUnattributedTokens, isUsageEmpty } from '../usage-accumulator';

const usage = (over: Partial<RealtimeUsage> = {}): RealtimeUsage => ({
  input_tokens: 10,
  output_tokens: 5,
  total_tokens: 15,
  input_token_details: { text_tokens: 4, audio_tokens: 6, image_tokens: 0 },
  output_token_details: { text_tokens: 2, audio_tokens: 3 },
  ...over,
});

describe('addUsage', () => {
  it('given two responses, should sum the totals', () => {
    const total = addUsage(usage(), usage());

    expect(total.input_tokens).toBe(20);
    expect(total.output_tokens).toBe(10);
    expect(total.total_tokens).toBe(30);
  });

  it('given two responses, should sum EACH modality separately', () => {
    // Modality is the cost driver — audio input is 8x text input — so a
    // blended total would be unpriceable.
    const total = addUsage(usage(), usage());

    expect(total.input_token_details).toMatchObject({
      text_tokens: 8,
      audio_tokens: 12,
      image_tokens: 0,
    });
    expect(total.output_token_details).toMatchObject({ text_tokens: 4, audio_tokens: 6 });
  });

  it('given no prior total, should start from the first response', () => {
    expect(addUsage(undefined, usage()).input_tokens).toBe(10);
  });

  it('given no new usage, should leave the running total unchanged', () => {
    const total = addUsage(usage(), undefined);
    expect(total.input_tokens).toBe(10);
    expect(total.input_token_details).toMatchObject({ text_tokens: 4, audio_tokens: 6 });
  });

  it('given both sides absent, should produce an empty total rather than undefined', () => {
    expect(isUsageEmpty(addUsage(undefined, undefined))).toBe(true);
  });

  it('given cached tokens, should keep them as their own subtotal and NOT fold them into the gross', () => {
    // `cached_tokens` is a SUBSET of `input_tokens`. Folding it in would bill
    // every cache hit twice.
    const total = addUsage(
      usage({ input_token_details: { text_tokens: 10, audio_tokens: 0, image_tokens: 0, cached_tokens: 4 } }),
      usage({ input_token_details: { text_tokens: 10, audio_tokens: 0, image_tokens: 0, cached_tokens: 6 } }),
    );

    expect(total.input_token_details?.text_tokens).toBe(20);
    expect(total.input_token_details?.cached_tokens).toBe(10);
  });

  it('given cached token DETAILS, should sum them per modality', () => {
    const total = addUsage(
      usage({
        input_token_details: {
          text_tokens: 10,
          audio_tokens: 10,
          image_tokens: 0,
          cached_tokens: 4,
          cached_tokens_details: { text_tokens: 1, audio_tokens: 3 },
        },
      }),
      usage({
        input_token_details: {
          text_tokens: 10,
          audio_tokens: 10,
          image_tokens: 0,
          cached_tokens: 2,
          cached_tokens_details: { text_tokens: 2, audio_tokens: 0 },
        },
      }),
    );

    expect(total.input_token_details?.cached_tokens_details).toMatchObject({
      text_tokens: 3,
      audio_tokens: 3,
      image_tokens: 0,
    });
  });

  it('given only one side has cached details, should still carry them', () => {
    const total = addUsage(
      usage({ input_token_details: { text_tokens: 4, audio_tokens: 0, image_tokens: 0 } }),
      usage({
        input_token_details: {
          text_tokens: 4,
          audio_tokens: 0,
          image_tokens: 0,
          cached_tokens_details: { text_tokens: 2 },
        },
      }),
    );

    expect(total.input_token_details?.cached_tokens_details).toMatchObject({ text_tokens: 2 });
  });

  it('given only ONE side carries detail blocks, should keep them rather than drop the whole block', () => {
    // Pricing reads only the detail blocks, so dropping them because one frame
    // lacked them would silently bill the call at zero.
    const total = addUsage(
      { input_tokens: 3, output_tokens: 0, total_tokens: 3 },
      usage(),
    );

    expect(total.input_token_details).toMatchObject({ text_tokens: 4, audio_tokens: 6 });
    expect(total.output_token_details).toMatchObject({ audio_tokens: 3 });
  });

  it('given malformed wire values, should contribute zero rather than NaN', () => {
    const malformed = {
      input_tokens: 'lots' as unknown as number,
      output_tokens: Number.NaN,
      total_tokens: -5,
      input_token_details: { text_tokens: undefined, audio_tokens: -1, image_tokens: Number.NaN },
    } as RealtimeUsage;

    const total = addUsage(usage(), malformed);

    expect(total.input_tokens).toBe(10);
    expect(total.output_tokens).toBe(5);
    expect(total.total_tokens).toBe(15);
    expect(Number.isNaN(total.input_token_details?.audio_tokens ?? 0)).toBe(false);
    // A NaN reaching the ledger is the one outcome this must never allow.
    expect(Number.isNaN(calculateRealtimeCostDollars('gpt-realtime-2.1', total))).toBe(false);
  });

  it('given a summed total, should price as the sum of its parts', () => {
    const one = calculateRealtimeCostDollars('gpt-realtime-2.1', usage());
    const summed = calculateRealtimeCostDollars('gpt-realtime-2.1', addUsage(usage(), usage()));

    expect(summed).toBeCloseTo(one * 2, 10);
  });

  it('given three responses folded in order, should equal the same three folded in any order', () => {
    const a = usage({ input_token_details: { text_tokens: 1, audio_tokens: 2, image_tokens: 3 } });
    const b = usage({ input_token_details: { text_tokens: 4, audio_tokens: 5, image_tokens: 6 } });
    const c = usage({ input_token_details: { text_tokens: 7, audio_tokens: 8, image_tokens: 9 } });

    expect(addUsage(addUsage(a, b), c)).toEqual(addUsage(addUsage(c, b), a));
  });
});

describe('isUsageEmpty', () => {
  it('given no usage at all, should be empty', () => {
    expect(isUsageEmpty(undefined)).toBe(true);
    expect(isUsageEmpty({})).toBe(true);
  });

  it('given all-zero counts, should be empty so an idle window settles nothing', () => {
    expect(
      isUsageEmpty({
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        input_token_details: { text_tokens: 0, audio_tokens: 0, image_tokens: 0 },
      }),
    ).toBe(true);
  });

  it('given any spend, should not be empty', () => {
    expect(isUsageEmpty(usage())).toBe(false);
    expect(isUsageEmpty({ input_token_details: { audio_tokens: 1 } })).toBe(false);
    expect(isUsageEmpty({ output_token_details: { text_tokens: 1 } })).toBe(false);
    expect(isUsageEmpty({ total_tokens: 1 })).toBe(false);
  });
});

describe('hasUnattributedTokens', () => {
  it('given totals with no modality breakdown, should report it — that portion bills $0', () => {
    expect(hasUnattributedTokens({ input_tokens: 100, output_tokens: 50 })).toBe(true);
    expect(calculateRealtimeCostDollars('gpt-realtime-2.1', { input_tokens: 100 })).toBe(0);
  });

  it('given attributed tokens, should report nothing', () => {
    expect(hasUnattributedTokens(usage())).toBe(false);
  });

  it('given output-only attribution, should count as attributed', () => {
    expect(
      hasUnattributedTokens({ input_tokens: 5, output_token_details: { audio_tokens: 5 } }),
    ).toBe(false);
  });

  it('given no usage or no reported totals, should report nothing', () => {
    expect(hasUnattributedTokens(undefined)).toBe(false);
    expect(hasUnattributedTokens({})).toBe(false);
  });
});
