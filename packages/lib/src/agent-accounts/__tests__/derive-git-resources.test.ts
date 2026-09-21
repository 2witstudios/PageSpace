/**
 * ADR 0004 §3.2, §8.42; ADR 0006 §7 — relay resources derived from the git
 * protocol request (G1c R11). Written RED before `derive-git-resources.ts`
 * exists (Control Board §7.2).
 */
import { describe, expect, it } from 'vitest';
import type { DerivedResourceRule } from '../canonical-request';
import { deriveGitResources } from '../derive-git-resources';

const OID_A = 'a'.repeat(40);
const OID_B = 'b'.repeat(40);
const ZERO = '0'.repeat(40);
const NUL = String.fromCharCode(0);
const ESC = String.fromCharCode(27);
const encoder = new TextEncoder();

function pkt(payload: string): string {
  const length = encoder.encode(payload).byteLength + 4;
  return length.toString(16).padStart(4, '0') + payload;
}

function receivePack(commands: readonly string[], trailer = `PACK${NUL}${NUL}${NUL}2`): Uint8Array {
  const lines = commands.map((command, index) => pkt(index === 0 ? `${command}${NUL}report-status side-band-64k\n` : `${command}\n`));
  return encoder.encode(lines.join('') + '0000' + trailer);
}

const REF_NAMES: DerivedResourceRule = { slot: 'ref', source: 'receive_pack_ref_names' };
const BRANCHES: DerivedResourceRule = { slot: 'branch', source: 'receive_pack_branches' };

describe('deriveGitResources (G1c R11)', () => {
  it('given a receive-pack updating a branch and a tag, should derive every ref name, and for branches the short name of a branch and the FULL name of anything else — so a branch allowlist can never admit the tag (G1c review)', () => {
    const body = receivePack([`${OID_A} ${OID_B} refs/heads/main`, `${ZERO} ${OID_A} refs/tags/v1`]);
    const actual = deriveGitResources({ method: 'git-receive-pack', rules: [REF_NAMES, BRANCHES], body });
    expect(actual).toEqual({
      ok: true,
      resources: [
        ['ref', 'refs/heads/main'],
        ['ref', 'refs/tags/v1'],
        ['branch', 'main'],
        ['branch', 'refs/tags/v1'],
      ],
    });
  });

  it('given a push to HEAD or refs/meta/config alongside an allowed branch, should still derive a branch value for each (never skip a ref)', () => {
    const body = receivePack([`${OID_A} ${OID_B} refs/heads/feature-x`, `${OID_A} ${OID_B} HEAD`, `${OID_A} ${OID_B} refs/meta/config`]);
    const actual = deriveGitResources({ method: 'git-receive-pack', rules: [BRANCHES], body });
    expect(actual).toEqual({
      ok: true,
      resources: [
        ['branch', 'feature-x'],
        ['branch', 'HEAD'],
        ['branch', 'refs/meta/config'],
      ],
    });
  });

  it('given a branch deletion with SHA-256 object ids and a nested branch name, should still derive the branch', () => {
    const body = receivePack([`${'c'.repeat(64)} ${'0'.repeat(64)} refs/heads/feature/x`]);
    const actual = deriveGitResources({ method: 'git-receive-pack', rules: [BRANCHES], body });
    expect(actual).toEqual({ ok: true, resources: [['branch', 'feature/x']] });
  });

  it('given no rules, should derive nothing without parsing the body', () => {
    const actual = deriveGitResources({ method: 'git-upload-pack', rules: [], body: encoder.encode('garbage') });
    expect(actual).toEqual({ ok: true, resources: [] });
  });

  it('given a rule on any method but git-receive-pack, should refuse malformed', () => {
    const body = receivePack([`${OID_A} ${OID_B} refs/heads/main`]);
    const actual = (['git-upload-pack', 'lfs-batch', 'lfs-upload'] as const).map((method) => deriveGitResources({ method, rules: [BRANCHES], body }));
    expect(actual).toEqual([
      { ok: false, reason: 'malformed' },
      { ok: false, reason: 'malformed' },
      { ok: false, reason: 'malformed' },
    ]);
  });

  it('given a ref or branch name that starts with -, or a ref carrying NUL or another control character, should refuse flag_injection', () => {
    const bodies = [
      receivePack([`${OID_A} ${OID_B} -f`]),
      receivePack([`${OID_A} ${OID_B} refs/heads/--upload-pack=x`]),
      receivePack([`${OID_A} ${OID_B} refs/heads/main`, `${OID_A} ${OID_B} refs/heads/a${NUL}b`]),
      receivePack([`${OID_A} ${OID_B} refs/heads/a${ESC}b`]),
    ];
    const actual = bodies.map((body) => deriveGitResources({ method: 'git-receive-pack', rules: [REF_NAMES, BRANCHES], body }));
    expect(actual).toEqual(bodies.map(() => ({ ok: false, reason: 'flag_injection' })));
  });

  it('given an unparseable command section — flush first, truncated or non-hex pkt-line length, a reserved length, a malformed command, no flush, empty — should refuse malformed', () => {
    const bodies = [
      encoder.encode('0000PACK'),
      encoder.encode('00ff' + `${OID_A} ${OID_B} refs/heads/main`),
      encoder.encode('zzzz' + `${OID_A} ${OID_B} refs/heads/main\n0000`),
      encoder.encode('0002' + '0000'),
      receivePack([`${OID_A} refs/heads/main`]),
      receivePack([`${OID_A.slice(1)} ${OID_B} refs/heads/main`]),
      encoder.encode(pkt(`${OID_A} ${OID_B} refs/heads/main${NUL}caps\n`)),
      new Uint8Array(0),
    ];
    const actual = bodies.map((body) => deriveGitResources({ method: 'git-receive-pack', rules: [REF_NAMES], body }));
    expect(actual).toEqual(bodies.map(() => ({ ok: false, reason: 'malformed' })));
  });
});
