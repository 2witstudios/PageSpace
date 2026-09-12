/**
 * Leaf B — the directory `list_environments` answers with. Every row below is
 * a Given/Should from the leaf's own page, plus the anti-invention wording
 * July's post-mortem (`cf576fbc1`) makes load-bearing.
 */
import { describe, it, expect } from 'vitest';
import {
  buildEnvironmentDirectory,
  environmentIdSchema,
  ENVIRONMENT_ID_SHAPE_MESSAGE,
  COPY_THE_ID_NOTICE,
  NO_VISIBLE_ENVIRONMENTS_NOTICE,
  OWN_SANDBOX_LABEL,
} from '../environment-directory';

const CONVERSATION = { id: 'conv_kv725pqqj5go7rcvp2mv', driveId: null };
const MAC = { id: 'env_dw9jthqyaza6ga3b6m5n', label: 'jono-macstudio', substrate: 'local' as const, driveId: 'drive_1' };

describe('buildEnvironmentDirectory', () => {
  it('given each row, should carry an opaque id, a human label, the substrate and the owning drive', () => {
    const { environments } = buildEnvironmentDirectory({ conversation: CONVERSATION, environments: [MAC] });
    const mac = environments.find((row) => row.id === MAC.id)!;
    expect(mac).toEqual({ id: MAC.id, label: 'jono-macstudio', substrate: 'local', driveId: 'drive_1', kind: 'environment' });
    // Every row carries all four facts — no row is a bare id.
    for (const row of environments) {
      expect(row.id.length).toBeGreaterThan(0);
      expect(row.label.length).toBeGreaterThan(0);
      expect(['sprite', 'local']).toContain(row.substrate);
      expect(row).toHaveProperty('driveId');
    }
  });

  it("given the conversation's own sandbox, should list it like any other environment — addressed by an id, named, first", () => {
    const { environments } = buildEnvironmentDirectory({ conversation: CONVERSATION, environments: [MAC] });
    expect(environments[0]).toEqual({ id: CONVERSATION.id, label: OWN_SANDBOX_LABEL, substrate: 'sprite', driveId: null, kind: 'conversation' });
    // There is no row without an id, so there is no implicit path to take.
    expect(environments.every((row) => typeof row.id === 'string' && row.id.length > 0)).toBe(true);
  });

  it('given the caller has no visible environments, should say so IN WORDS rather than returning an empty list', () => {
    const directory = buildEnvironmentDirectory({ conversation: CONVERSATION, environments: [] });
    expect(directory.notice).toContain(NO_VISIBLE_ENVIRONMENTS_NOTICE);
    expect(directory.notice).toContain(COPY_THE_ID_NOTICE);
    // Never a bare empty array with a mandatory field left to invent.
    expect(directory.environments).toHaveLength(1);
    expect(directory.environments[0]!.kind).toBe('conversation');
  });

  it('every answer instructs the model to COPY an id and never to construct one — the wording is part of the fix', () => {
    for (const envs of [[], [MAC]]) {
      const { notice } = buildEnvironmentDirectory({ conversation: CONVERSATION, environments: envs });
      expect(notice).toMatch(/copy it exactly/i);
      expect(notice).toMatch(/never construct, shorten or guess/i);
      expect(notice).toMatch(/never reuse an id from an earlier conversation/i);
      expect(notice).toContain('environmentId');
    }
  });

  it('a drive-scoped conversation carries its drive on its own sandbox row; the directory never invents one', () => {
    const { environments } = buildEnvironmentDirectory({ conversation: { id: 'conv_2', driveId: 'drive_9' }, environments: [] });
    expect(environments[0]!.driveId).toBe('drive_9');
  });

  it('passes the store\'s rows through unchanged — the builder shapes, it never filters', () => {
    const second = { id: 'env_2', label: 'office-linux', substrate: 'local' as const, driveId: 'drive_2' };
    const { environments } = buildEnvironmentDirectory({ conversation: CONVERSATION, environments: [MAC, second] });
    expect(environments.map((row) => row.id)).toEqual([CONVERSATION.id, MAC.id, second.id]);
  });
});

describe('environmentIdSchema — the opaque id SHAPE at the zod boundary (leaf C)', () => {
  it('accepts a real id and REFUSES every value July saw the model invent', () => {
    expect(environmentIdSchema.safeParse('a78aoz3je2ycbofz79zgez9q').success).toBe(true);
    for (const invented of ['main', 'staging', 'prod', 'develop', 'HEAD', 'my-machine', 'jono-macstudio', '/workspace/repo', 'localhost', '', 'a']) {
      expect(environmentIdSchema.safeParse(invented).success, invented).toBe(false);
    }
  });

  it('the length floor is what does the work — isCuid alone accepts a branch name', () => {
    // Documented so a future reader does not "simplify" the floor away: `isCuid`
    // is a loose heuristic over lowercase alphanumerics, and every id this
    // system mints is a 24-character cuid2.
    expect(environmentIdSchema.safeParse('abcdefghij').success).toBe(false);
    expect(environmentIdSchema.safeParse('a'.repeat(20)).success).toBe(true);
    expect(environmentIdSchema.safeParse('a'.repeat(33)).success).toBe(false);
  });

  it('refuses uppercase, punctuation and whitespace outright — an id is not a description', () => {
    for (const bad of ['A78AOZ3JE2YCBOFZ79ZGEZ9Q', 'a78aoz3je2ycbofz79zgez9q ', 'env_a78aoz3je2ycbofz79zge', 'a78aoz3je2ycbofz79zgez9q!']) {
      expect(environmentIdSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('says what to do instead, in the same register as every other refusal', () => {
    const parsed = environmentIdSchema.safeParse('main');
    expect(parsed.success).toBe(false);
    expect(ENVIRONMENT_ID_SHAPE_MESSAGE).toContain('list_environments');
    expect(ENVIRONMENT_ID_SHAPE_MESSAGE).toMatch(/copy an id from its output exactly/i);
    if (!parsed.success) expect(parsed.error.issues[0]!.message).toBe(ENVIRONMENT_ID_SHAPE_MESSAGE);
  });
});
