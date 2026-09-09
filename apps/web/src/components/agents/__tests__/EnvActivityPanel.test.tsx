/**
 * `EnvActivityPanel` (GA wave 3, leaf 2): running rows are always first and
 * never buried by history, every verdict in the audit vocabulary has words,
 * and a non-owner (enabled: false) gets nothing — not even a request.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const mockUseEnvActivity = vi.fn();
vi.mock('@/hooks/drive-envs/useEnvActivity', () => ({ useEnvActivity: (...args: unknown[]) => mockUseEnvActivity(...args) }));

import { EnvActivityPanel, describeVerdict } from '../EnvActivityPanel';
import type { DriveEnvActivityDTO } from '@pagespace/lib/drive-envs/env-contract';

const row = (over: Partial<DriveEnvActivityDTO>): DriveEnvActivityDTO => ({ id: 'r', envId: 'env-1', grantId: 'g', userId: 'u', sessionId: 's', conversationId: 'c', op: 'exec', summary: 'exec: ls', verdict: 'signed', exitCode: null, challengeId: null, approvalScope: null, ts: '2026-09-09T12:00:00.000Z', resultAt: null, ...over });

beforeEach(() => {
  vi.clearAllMocks();
});

function feed(activity: DriveEnvActivityDTO[]) {
  mockUseEnvActivity.mockReturnValue({ activity, running: activity.filter((r) => r.verdict === 'signed' && r.resultAt === null), isLoading: false, error: undefined, refresh: vi.fn() });
}

describe('describeVerdict — the audit vocabulary in the owner\'s words', () => {
  it.each([
    [row({ verdict: 'signed' }), 'Running', 'running'],
    [row({ verdict: 'completed', exitCode: 0, resultAt: 't' }), 'Done', 'ok'],
    [row({ verdict: 'completed', exitCode: 2, resultAt: 't' }), 'Exit 2', 'failed'],
    [row({ verdict: 'completed:write_failed', resultAt: 't' }), 'Write failed', 'failed'],
    [row({ verdict: 'ask_pending:ch_1', resultAt: 't' }), 'Waiting for your approval', 'pending'],
    [row({ verdict: 'denied:not_allowed', resultAt: 't' }), 'Machine refused (not_allowed)', 'refused'],
    [row({ verdict: 'refused:server_denied', resultAt: 't' }), 'PageSpace refused (server_denied)', 'refused'],
    [row({ verdict: 'failed:timeout', resultAt: 't' }), 'Failed (timeout)', 'failed'],
  ] as const)('%#: $verdict', (input, label, tone) => {
    expect(describeVerdict(input)).toEqual({ label, tone });
  });
});

describe('EnvActivityPanel', () => {
  it('given running and settled rows, shows "Running now" first with the live indicator, then the recent tail with what each did', () => {
    feed([row({ id: 'run', summary: "exec: sh -c 'sleep 30'" }), row({ id: 'done', summary: 'exec: git status', verdict: 'completed', exitCode: 0, resultAt: '2026-09-09T11:59:00.000Z' }), row({ id: 'ref', summary: 'exec: rm -rf /', verdict: 'refused:server_denied', resultAt: '2026-09-09T11:58:00.000Z', grantId: null })]);
    render(<EnvActivityPanel driveId="drive-1" envId="env-1" enabled compact />);
    expect(mockUseEnvActivity).toHaveBeenCalledWith({ driveId: 'drive-1', envId: 'env-1' }, { enabled: true });
    const panel = screen.getByTestId('env-activity-panel-env-1');
    expect(panel).toHaveTextContent('Running now (1)');
    expect(screen.getByRole('img', { name: 'Running' })).toBeInTheDocument();
    const rows = [...panel.querySelectorAll('li')].map((li) => li.getAttribute('data-verdict'));
    expect(rows).toEqual(['signed', 'completed', 'refused:server_denied']);
    expect(screen.getByTestId('env-activity-done')).toHaveTextContent('Done');
    expect(screen.getByTestId('env-activity-ref')).toHaveTextContent('PageSpace refused (server_denied)');
  });

  it('given a click-approved row, says so with the scope the owner chose', () => {
    feed([row({ id: 'ok', verdict: 'completed', exitCode: 0, resultAt: 't', challengeId: 'ch_1', approvalScope: '30d' })]);
    render(<EnvActivityPanel driveId="drive-1" envId="env-1" enabled />);
    expect(screen.getByTestId('env-activity-ok')).toHaveTextContent('approved (30d)');
  });

  it('given nothing running, says so plainly rather than rendering an empty list', () => {
    feed([]);
    render(<EnvActivityPanel driveId="drive-1" envId="env-1" enabled />);
    expect(screen.getByText('Nothing is running on this machine.')).toBeInTheDocument();
    expect(screen.getByText('Nothing has run yet.')).toBeInTheDocument();
  });

  it('compact: the tail is capped at three settled rows, running rows are never capped', () => {
    feed([row({ id: 'a' }), row({ id: 'b' }), ...[1, 2, 3, 4, 5].map((n) => row({ id: `d${n}`, verdict: 'completed', exitCode: 0, resultAt: 't' }))]);
    render(<EnvActivityPanel driveId="drive-1" envId="env-1" enabled compact />);
    const panel = screen.getByTestId('env-activity-panel-env-1');
    expect(panel.querySelectorAll('li')).toHaveLength(5);
  });

  it('given enabled: false (not the machine owner), renders nothing and passes the disabled flag to the hook', () => {
    feed([row({ id: 'x' })]);
    const { container } = render(<EnvActivityPanel driveId="drive-1" envId="env-1" enabled={false} />);
    expect(container).toBeEmptyDOMElement();
    expect(mockUseEnvActivity).toHaveBeenCalledWith({ driveId: 'drive-1', envId: 'env-1' }, { enabled: false });
  });
});
