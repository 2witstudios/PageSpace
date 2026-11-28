import { describe, it, expect } from 'vitest';
import type { UserId } from '../../grant';
import { decideSshAccount } from '../decide-ssh-account';

const FP = `SHA256:${'A'.repeat(43)}`;
const base = { name: 'Build box', host: 'Build.Example.com', port: null, username: 'deploy', hostKeySha256: FP, ownership: 'dedicated' as const, acknowledged: false, runWithoutAsking: false };
const decide = (overrides: Partial<typeof base> = {}) => decideSshAccount({ input: { ...base, ...overrides }, approver: 'u' as UserId });

describe('decideSshAccount', () => {
  it('given a host, user and confirmed key, should pin one ssh:// target and ask for every command by default', () => {
    const actual = decide();
    expect(actual.ok && { origins: actual.draft.allowedOrigins, policy: actual.draft.approvalPolicy, user: actual.draft.username }).toEqual({ origins: ['ssh://build.example.com:22'], policy: null, user: 'deploy' });
  });

  it('given "run without asking", should cover ssh.exec on that target only, up to 30 an hour', () => {
    const actual = decide({ runWithoutAsking: true });
    expect(actual.ok && [actual.draft.approvalPolicy?.scope, actual.draft.approvalPolicy?.limits.maxUsesPerHour]).toEqual([{ origins: ['ssh://build.example.com:22'], operations: [{ class: 'unknown', name: 'ssh.exec' }], resources: [] }, 30]);
  });

  it('given a bad user, an unconfirmed or malformed host key, a bad host or a personal login without acknowledgment, should refuse', () => {
    const actual = [decide({ username: 'root;rm' }), decide({ hostKeySha256: 'md5:ab' }), decide({ host: 'x y' }), decide({ ownership: 'personal' as never })].map((verdict) => (verdict.ok ? 'ok' : verdict.reason));
    expect(actual).toEqual(['username_invalid', 'host_key_invalid', 'host_invalid', 'acknowledgment_required']);
  });
});
