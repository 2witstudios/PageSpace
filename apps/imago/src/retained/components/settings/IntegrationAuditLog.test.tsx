// @vitest-environment jsdom
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { mount, unmountAll } from '@/ui/test-support/dom';
import { IntegrationAuditLog, auditQuery } from './IntegrationAuditLog';

const spies = vi.hoisted(() => ({ useIntegrationAuditLogs: vi.fn(), useDriveConnections: vi.fn() }));

vi.mock('@/retained/hooks/useIntegrations', () => ({
  useIntegrationAuditLogs: spies.useIntegrationAuditLogs,
  useDriveConnections: spies.useDriveConnections,
}));

// Radix Select measures its trigger with ResizeObserver, which jsdom does not provide.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverStub);

afterEach(unmountAll);

const LOG = {
  id: 'l1',
  createdAt: '2026-10-09T16:52:00Z',
  toolName: 'search',
  connectionId: 'c2',
  success: false,
  responseCode: null,
  errorType: 'unauthorized',
  durationMs: 88,
};

describe('auditQuery', () => {
  test('sends no filter for All connections and All statuses', () => {
    assert({
      given: 'the default filters',
      should: 'query the first page with no connection or success filter',
      actual: auditQuery('all', 'all', 0),
      expected: { limit: 20, offset: 0 },
    });
  });

  test('the Failed status and a connection become success=false and connectionId', () => {
    assert({
      given: 'Status Failed on one connection, second page',
      should: 'query the failed calls of that connection at the page offset',
      actual: auditQuery('c2', 'false', 20),
      expected: { limit: 20, offset: 20, connectionId: 'c2', success: false },
    });
  });

  test('the Success status becomes success=true', () => {
    assert({
      given: 'Status Success',
      should: 'query successful calls only',
      actual: auditQuery('all', 'true', 0),
      expected: { limit: 20, offset: 0, success: true },
    });
  });
});

describe('IntegrationAuditLog', () => {
  test('draws the audit table with its columns and the Connection and Status filters', () => {
    spies.useDriveConnections.mockReturnValue({ connections: [{ id: 'c2', name: 'Research' }], isLoading: false, error: undefined, mutate: vi.fn() });
    spies.useIntegrationAuditLogs.mockReturnValue({ logs: [LOG], total: 1, isLoading: false, error: undefined });
    const container = mount(<IntegrationAuditLog driveId="d1" />);
    const headers = [...container.querySelectorAll('th')].map((th) => th.textContent);
    assert({
      given: 'one failed call on the Research connection',
      should: 'show the Audit log heading, the five columns, Failed as the status and the connection name',
      actual: {
        heading: container.querySelector('h2')?.textContent,
        headers,
        filters: ['Connection', 'Status'].map((label) => container.querySelector(`[aria-label="${label}"]`) !== null),
        status: container.querySelector('td span')?.textContent,
        connection: container.textContent?.includes('Research') ?? false,
      },
      expected: {
        heading: 'Audit log',
        headers: ['Timestamp', 'Tool', 'Connection', 'Status', 'Duration'],
        filters: [true, true],
        status: 'Failed',
        connection: true,
      },
    });
  });
});
