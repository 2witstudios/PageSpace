import { describe, expect, it } from 'vitest';
import {
  backupsHintOf,
  commandsHintOf,
  domainsHintOf,
  integrationsHintOf,
  overviewGroups,
  rolesHintOf,
  type OverviewHints,
} from './settings-overview-model';

describe('commandsHintOf', () => {
  it('counts this drive\'s commands and the ones switched off, ignoring other drives and junk', () => {
    expect(
      commandsHintOf(
        { commands: [{ driveId: 'd1', enabled: true }, { driveId: 'd1', enabled: false }, { driveId: 'd2' }, null, 'x'] },
        'd1',
      ),
    ).toEqual({ total: 2, off: 1 });
  });
  it('reads anything but a commands list as no answer', () => {
    expect([commandsHintOf(null, 'd1'), commandsHintOf('x', 'd1'), commandsHintOf({ commands: 3 }, 'd1')]).toEqual([null, null, null]);
  });
});

describe('rolesHintOf', () => {
  it('names the custom roles and flags the default, skipping malformed entries', () => {
    expect(rolesHintOf({ roles: [{ name: 'Editor', isDefault: true }, { name: 'Viewer' }, { name: 3 }, null] })).toEqual({
      names: [{ name: 'Editor', isDefault: true }, { name: 'Viewer', isDefault: false }],
    });
  });
  it('reads a body without a roles list as no answer', () => {
    expect([rolesHintOf(undefined), rolesHintOf({ roles: {} })]).toEqual([null, null]);
  });
});

describe('integrationsHintOf', () => {
  it('counts every connection and names the expired ones', () => {
    expect(
      integrationsHintOf({ connections: [{ name: 'GitHub', status: 'expired' }, { name: 'Slack', status: 'active' }, { status: 'expired' }, null] }),
    ).toEqual({ connected: 4, expired: ['GitHub'] });
  });
  it('reads a body without connections as no answer', () => {
    expect([integrationsHintOf(null), integrationsHintOf({ connections: 'x' })]).toEqual([null, null]);
  });
});

describe('domainsHintOf', () => {
  it('sorts domains into live, waiting on DNS and failed', () => {
    const statuses = ['active', 'active', 'pending', 'dns_failed', 'cert_failed', 'failed', 'weird'];
    expect(domainsHintOf({ domains: [...statuses.map((status) => ({ status })), null] })).toEqual({ live: 2, waitingOnDns: 1, failed: 3 });
  });
  it('reads a body without domains as no answer', () => {
    expect([domainsHintOf([]), domainsHintOf({ domains: null })]).toEqual([null, null]);
  });
});

describe('backupsHintOf', () => {
  it('reads the schedule, with a last run only when it is a string', () => {
    expect([
      backupsHintOf({ enabled: true, frequency: 'weekly', lastRunAt: '2026-10-06T10:00:00.000Z' }),
      backupsHintOf({ enabled: false, frequency: 'daily', lastRunAt: 5 }),
    ]).toEqual([
      { enabled: true, frequency: 'weekly', lastRunAt: '2026-10-06T10:00:00.000Z' },
      { enabled: false, frequency: 'daily', lastRunAt: null },
    ]);
  });
  it('rejects a body that is not the schedule', () => {
    expect([backupsHintOf(null), backupsHintOf({ enabled: 'yes', frequency: 'daily' }), backupsHintOf({ enabled: true })]).toEqual([null, null, null]);
  });
});

const rowsOf = (hints: OverviewHints, opts: { canManage?: boolean; isOwner?: boolean } = {}) =>
  overviewGroups({ driveId: 'd 1', canManage: opts.canManage ?? true, isOwner: opts.isOwner ?? true, hints }).flatMap((group) => group.rows);
const rowById = (hints: OverviewHints, id: string) => rowsOf(hints).find((row) => row.id === id);

describe('overviewGroups', () => {
  it('shows a plain member only Commands', () => {
    const groups = overviewGroups({ driveId: 'd1', canManage: false, isOwner: false, hints: {} });
    expect(groups.map((group) => [group.label, group.rows.map((row) => row.id)])).toEqual([['AI & connections', ['commands']]]);
  });

  it('shows an admin every screen but the owner\'s, and the owner Danger zone too', () => {
    const admin = overviewGroups({ driveId: 'd1', canManage: true, isOwner: false, hints: {} });
    const owner = overviewGroups({ driveId: 'd1', canManage: true, isOwner: true, hints: {} });
    expect(admin.map((group) => group.label)).toEqual(['Drive', 'AI & connections', 'Data & publishing']);
    expect(owner.map((group) => group.label)).toEqual([...admin.map((group) => group.label), 'Administration']);
    expect(owner.at(-1)?.rows[0]).toMatchObject({ id: 'danger', danger: true, state: 'Drive lead only', href: '/d1/settings/danger' });
  });

  it('encodes the drive in each link and points General at /general', () => {
    const rows = rowsOf({});
    expect([rows[0]?.href, rows[1]?.href]).toEqual(['/d%201/settings/general', '/d%201/settings/roles']);
  });

  it('leaves every state out until its answer arrives', () => {
    expect(rowsOf({}).filter((row) => row.id !== 'danger').map((row) => [row.state, row.tone])).toEqual(
      Array.from({ length: 7 }, () => [null, 'none']),
    );
  });

  it('describes roles, with and without custom ones', () => {
    expect([
      rowById({ roles: { names: [] } }, 'roles')?.state,
      rowById({ roles: { names: [{ name: 'Editor', isDefault: true }, { name: 'Viewer', isDefault: false }] } }, 'roles')?.state,
      rowById({ roles: null }, 'roles')?.state,
    ]).toEqual(['No custom roles', 'Editor (default), Viewer', null]);
  });

  it('describes integrations: expired first, else the count', () => {
    expect([
      rowById({ integrations: { connected: 3, expired: ['GitHub', 'Slack'] } }, 'integrations'),
      rowById({ integrations: { connected: 0, expired: [] } }, 'integrations'),
      rowById({ integrations: { connected: 2, expired: [] } }, 'integrations'),
    ].map((row) => [row?.state, row?.tone])).toEqual([
      ['GitHub expired', 'warn'],
      ['None connected', 'none'],
      ['2 connected', 'none'],
    ]);
  });

  it('describes commands: none, some, and some switched off', () => {
    expect([
      rowById({ commands: { total: 0, off: 0 } }, 'commands')?.state,
      rowById({ commands: { total: 1, off: 0 } }, 'commands')?.state,
      rowById({ commands: { total: 1200, off: 2 } }, 'commands')?.state,
    ]).toEqual(['No commands yet', '1 command', '1,200 commands · 2 off']);
  });

  it('describes the context length, and nothing for a drive with no prompt', () => {
    expect([rowById({ contextLength: 1234 }, 'context')?.state, rowById({ contextLength: null }, 'context')?.state]).toEqual([
      '1,234 / 10,000 chars',
      null,
    ]);
  });

  it('describes backups: off, on with no run, with a bad date, and with the last run', () => {
    const state = (backups: OverviewHints['backups']) => {
      const row = rowById({ backups }, 'backups');
      return [row?.state, row?.tone];
    };
    expect([
      state({ enabled: false, frequency: 'daily', lastRunAt: null }),
      state({ enabled: true, frequency: 'daily', lastRunAt: null }),
      state({ enabled: true, frequency: 'weekly', lastRunAt: 'not a date' }),
      state({ enabled: true, frequency: 'weekly', lastRunAt: '2026-10-06T23:30:00.000Z' }),
      state(null),
    ]).toEqual([
      ['Off', 'none'],
      ['Daily', 'ok'],
      ['Weekly', 'ok'],
      ['Weekly · last Oct 6', 'ok'],
      [null, 'none'],
    ]);
  });

  it('describes domains: none, live, waiting on DNS and failed', () => {
    const state = (domains: OverviewHints['domains']) => {
      const row = rowById({ domains }, 'domains');
      return [row?.state, row?.tone];
    };
    expect([
      state({ live: 0, waitingOnDns: 0, failed: 0 }),
      state({ live: 2, waitingOnDns: 0, failed: 0 }),
      state({ live: 1, waitingOnDns: 1, failed: 0 }),
      state({ live: 0, waitingOnDns: 0, failed: 2 }),
      state(null),
    ]).toEqual([
      ['No custom domains', 'none'],
      ['2 live', 'ok'],
      ['1 live · 1 waiting on DNS', 'warn'],
      ['2 failed', 'warn'],
      [null, 'none'],
    ]);
  });
});
