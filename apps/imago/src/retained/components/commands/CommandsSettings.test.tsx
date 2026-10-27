// @vitest-environment jsdom
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { mount, unmountAll } from '@/ui/test-support/dom';

const fixtures = vi.hoisted(() => {
  const command = (
    id: string,
    trigger: string,
    overrides: Record<string, unknown> = {},
  ) => ({
    id,
    scope: 'user',
    driveId: null,
    trigger,
    description: `Describes ${trigger}`,
    entryPageId: `p-${id}`,
    type: 'page',
    enabled: true,
    entryPageTitle: `Entry for ${trigger}`,
    entryPageDriveId: 'd1',
    entryPageAvailable: true,
    authorName: null,
    createdAt: '2026-10-12T10:00:00.000Z',
    updatedAt: '2026-10-12T10:00:00.000Z',
    ...overrides,
  });
  return {
    commands: [
      command('c1', 'standup'),
      command('c2', 'launch'),
      command('c3', 'review', { enabled: false }),
      command('c4', 'hiring', { entryPageAvailable: false }),
      command('c5', 'launch', { scope: 'drive', driveId: 'd1', entryPageTitle: 'Q4 Launch Plan' }),
    ],
  };
});

vi.mock('@/retained/hooks/useCommands', () => ({
  useCommands: () => ({
    commands: fixtures.commands,
    isLoading: false,
    toggleEnabled: vi.fn(),
    createCommand: vi.fn(),
    updateCommand: vi.fn(),
    deleteCommand: vi.fn(),
  }),
}));
vi.mock('@/retained/hooks/useDrive', () => ({
  useDriveStore: (select: (state: { drives: unknown[] }) => unknown) =>
    select({ drives: [{ id: 'd1', name: 'Studio' }] }),
}));
vi.mock('@/retained-adapters/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('./CommandFormDialog', () => ({ CommandFormDialog: () => null }));

const { CommandsSettings } = await import('./CommandsSettings');

afterEach(unmountAll);

describe('CommandsSettings, personal scope (IMC-7.31)', () => {
  test('each command shows its trigger, description, entry page link and an Enable/Disable switch', () => {
    const root = mount(<CommandsSettings scope="personal" canManage />);
    assert({
      given: 'personal commands',
      should: 'show /trigger, its description and entry page, and a switch named Disable or Enable',
      actual: [
        root.textContent?.includes('/standup'),
        root.textContent?.includes('Describes standup'),
        root.querySelector('a[href="/p/p-c1"]')?.textContent,
        root.querySelector('button[aria-label="Disable /standup"]') !== null,
        root.querySelector('button[aria-label="Enable /review"]') !== null,
        root.querySelector('button[aria-label="Actions for /standup"]') !== null,
      ],
      expected: [true, true, 'Entry for standup', true, true, true],
    });
  });

  test('a command whose entry page is gone reads Entry page unavailable and links nothing', () => {
    const root = mount(<CommandsSettings scope="personal" canManage />);
    const row = Array.from(root.querySelectorAll('div')).find((el) => el.textContent?.startsWith('/hiring'));
    assert({
      given: 'a command whose entry page is unavailable',
      should: 'show the Entry page unavailable badge and no link to the page',
      actual: [row?.textContent?.includes('Entry page unavailable'), row?.querySelector('a') ?? null],
      expected: [true, null],
    });
  });

  test('a personal command that shadows a drive command says which drive it shadows', () => {
    const root = mount(<CommandsSettings scope="personal" canManage />);
    const badge = Array.from(root.querySelectorAll('div,span')).find((el) => el.textContent === 'Shadows Studio');
    assert({
      given: 'a personal /launch with a drive /launch in Studio',
      should: 'show a Shadows Studio badge titled with the drive command it overrides',
      actual: [badge !== undefined, badge?.getAttribute('title')],
      expected: [true, 'Overrides the drive command with the same trigger in Studio'],
    });
  });

  test('the resource count is not shown, since commands carry no child count', () => {
    const root = mount(<CommandsSettings scope="personal" canManage />);
    assert({
      given: 'commands with no child count',
      should: 'show no "resources" count on any row',
      actual: root.textContent?.includes('resources'),
      expected: false,
    });
  });
});
