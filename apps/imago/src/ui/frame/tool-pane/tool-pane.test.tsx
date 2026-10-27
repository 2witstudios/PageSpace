// @vitest-environment jsdom
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { mount, unmountAll } from '../../test-support/dom';
import { HomeDriveProvider } from '../drives/home-drive-context';
import type { DriveTool } from '../stage/stage';

const pane = (name: string) =>
  function Pane({ driveId, allDrives }: { driveId: string; allDrives?: boolean }) {
    return <p>{`${name}:${driveId}:${allDrives ? 'all' : 'one'}`}</p>;
  };
vi.mock('../../tools/calendar/calendar-pane', () => ({ CalendarPane: pane('calendar') }));
vi.mock('../../tools/agents/console-pane', () => ({ ConsolePane: pane('agents') }));
vi.mock('../../tools/workflows/workflows-pane', () => ({ WorkflowsPane: pane('workflows') }));
vi.mock('../../tools/activity/activity-pane', () => ({ ActivityPane: pane('activity') }));
vi.mock('../../tools/members/members-pane', () => ({ MembersPane: pane('members') }));
vi.mock('../../files/files-pane/files-pane', () => ({ FilesPane: pane('files') }));

const { ToolPane } = await import('./tool-pane');
const { setSectionScope } = await import('../drives/use-section-scope');

afterEach(unmountAll);

const at = (tool: DriveTool, driveId: string) =>
  mount(
    <HomeDriveProvider value="home">
      <ToolPane tool={tool} driveId={driveId} close={null} />
    </HomeDriveProvider>,
  ).textContent;

describe('ToolPane', () => {
  test('on Home, the dashboard tools read every drive', () => {
    assert({
      given: 'Home’s Calendar, Console, Activity and Workflows',
      should: 'scope Calendar and Activity to every drive, give Console every drive’s sessions, and keep Workflows Home’s own',
      actual: (['calendar', 'agents', 'activity', 'workflows'] as const).map((tool) => at(tool, 'home')),
      expected: ['calendar:home:all', 'agents:home:all', 'activity:home:all', 'workflows:home:one'],
    });
  });

  test('another drive stays its own', () => {
    assert({
      given: 'a drive that is not Home',
      should: 'keep each tool scoped to that drive',
      actual: (['calendar', 'agents', 'activity'] as const).map((tool) => at(tool, 'd1')),
      expected: ['calendar:d1:one', 'agents:d1:one', 'activity:d1:one'],
    });
  });

  test('switched scopes hold on every drive', () => {
    setSectionScope('calendar', 'all');
    setSectionScope('activity', 'drive');
    const actual = [at('calendar', 'd1'), at('activity', 'home'), at('agents', 'd1')];
    setSectionScope('calendar', 'drive');
    setSectionScope('activity', 'all');
    assert({
      given: 'Calendar switched to All drives and Activity to this drive',
      should: 'read every drive’s calendar on another drive and only Home’s activity on Home, leaving Console as it was',
      actual,
      expected: ['calendar:d1:all', 'activity:home:one', 'agents:d1:one'],
    });
  });
});
