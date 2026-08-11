import { describe, expect, it } from 'vitest';
import {
  buildSessionConfig,
  CLIENT_SECRETS_URL,
  DEFAULT_REALTIME_MODEL,
  extractClientSecret,
  REALTIME_CALLS_URL,
  REALTIME_DATA_CHANNEL,
  REALTIME_MODEL_ENV_VAR,
  REALTIME_VOICE,
  resolveRealtimeModel,
  SDP_CONTENT_TYPE,
  type RealtimeTool,
} from '../session';

const tool: RealtimeTool = {
  type: 'function',
  name: 'read_page',
  description: 'Read a page aloud.',
  parameters: { type: 'object', properties: { pageId: { type: 'string' } } },
};

describe('buildSessionConfig', () => {
  it('given the realtime API, should declare the session type and default model', () => {
    const { session } = buildSessionConfig();
    expect(session.type).toBe('realtime');
    expect(session.model).toBe(DEFAULT_REALTIME_MODEL);
    // Pinned: access is per-account and /v1/realtime/calls 403s at connect time
    // for an unentitled model, so a change here must be verified against that
    // endpoint (mint returns 200 regardless) and overridden per-environment via
    // OPENAI_REALTIME_MODEL rather than edited.
    expect(DEFAULT_REALTIME_MODEL).toBe('gpt-realtime-2.1');
  });

  it('given speech output, should set the default voice', () => {
    expect(buildSessionConfig().session.audio.output.voice).toBe(
      REALTIME_VOICE,
    );
    expect(REALTIME_VOICE).toBe('marin');
  });

  it('given no options, should match the documented client_secrets body', () => {
    expect(buildSessionConfig()).toEqual({
      session: {
        type: 'realtime',
        model: 'gpt-realtime-2.1',
        audio: { output: { voice: 'marin' } },
        tools: [],
        tool_choice: 'auto',
      },
    });
  });

  it('given a model override, should use it instead of the default', () => {
    expect(buildSessionConfig({ model: 'gpt-realtime-2.1' }).session.model).toBe(
      'gpt-realtime-2.1',
    );
  });

  it('given a voice override, should use it instead of the default', () => {
    expect(buildSessionConfig({ voice: 'cedar' }).session.audio.output.voice).toBe(
      'cedar',
    );
  });

  it('given tools, should declare them flat with tool_choice auto', () => {
    const { session } = buildSessionConfig({ tools: [tool] });
    expect(session.tools).toEqual([tool]);
    expect(session.tool_choice).toBe('auto');
  });

  it('given instructions, should include them', () => {
    expect(buildSessionConfig({ instructions: 'Be brief.' }).session).toMatchObject(
      { instructions: 'Be brief.' },
    );
  });

  it('given an empty instructions string, should still send it rather than drop it', () => {
    expect(buildSessionConfig({ instructions: '' }).session).toHaveProperty(
      'instructions',
      '',
    );
  });

  it('given no instructions, should omit the key rather than send an empty one', () => {
    expect(buildSessionConfig().session).not.toHaveProperty('instructions');
  });
});

describe('resolveRealtimeModel', () => {
  it('given no override, should use the default model', () => {
    expect(resolveRealtimeModel({})).toBe(DEFAULT_REALTIME_MODEL);
  });

  it('given an override, should use it — the env var is the path to a newer model', () => {
    expect(
      resolveRealtimeModel({ [REALTIME_MODEL_ENV_VAR]: 'gpt-realtime-2.1' }),
    ).toBe('gpt-realtime-2.1');
  });

  it('given an override with surrounding whitespace, should trim it', () => {
    expect(
      resolveRealtimeModel({ [REALTIME_MODEL_ENV_VAR]: '  gpt-realtime-2.1  ' }),
    ).toBe('gpt-realtime-2.1');
  });

  it('given a blank override, should fall back to the default', () => {
    expect(resolveRealtimeModel({ [REALTIME_MODEL_ENV_VAR]: '   ' })).toBe(
      DEFAULT_REALTIME_MODEL,
    );
    expect(resolveRealtimeModel({ [REALTIME_MODEL_ENV_VAR]: '' })).toBe(
      DEFAULT_REALTIME_MODEL,
    );
  });

  it('given an explicitly undefined override, should fall back to the default', () => {
    expect(resolveRealtimeModel({ [REALTIME_MODEL_ENV_VAR]: undefined })).toBe(
      DEFAULT_REALTIME_MODEL,
    );
  });

  it('given a resolved model, should be usable as the session model', () => {
    const model = resolveRealtimeModel({
      [REALTIME_MODEL_ENV_VAR]: 'gpt-realtime-2.1',
    });
    expect(buildSessionConfig({ model }).session.model).toBe('gpt-realtime-2.1');
  });
});

describe('endpoints', () => {
  it('given the mint step, should point at client_secrets', () => {
    expect(CLIENT_SECRETS_URL).toBe(
      'https://api.openai.com/v1/realtime/client_secrets',
    );
  });

  it('given the connect step, should POST SDP to calls on the oai-events channel', () => {
    expect(REALTIME_CALLS_URL).toBe('https://api.openai.com/v1/realtime/calls');
    expect(SDP_CONTENT_TYPE).toBe('application/sdp');
    expect(REALTIME_DATA_CHANNEL).toBe('oai-events');
  });
});

describe('extractClientSecret', () => {
  it('given the documented shape, should return the secret', () => {
    expect(extractClientSecret({ value: 'ek_123' })).toBe('ek_123');
  });

  it('given a missing value, should return undefined', () => {
    expect(extractClientSecret({})).toBeUndefined();
  });

  it('given an empty value, should treat it as missing', () => {
    expect(extractClientSecret({ value: '' })).toBeUndefined();
  });

  it('given a non-string value, should treat it as missing', () => {
    expect(extractClientSecret({ value: 42 })).toBeUndefined();
  });

  it('given null, should not throw', () => {
    expect(extractClientSecret(null)).toBeUndefined();
  });

  it('given a non-object, should not throw', () => {
    expect(extractClientSecret('ek_123')).toBeUndefined();
  });
});
