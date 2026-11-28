import { describe, it, expect } from 'vitest';
import { findRegistryEntryDefects } from '../../find-registry-entry-defects';
import { findOperationRegistryConflicts } from '../../find-operation-registry-conflicts';
import { canonicalizeRequest } from '../../canonicalize-request';
import type { CanonicalRequestInput } from '../../canonical-request';
import { AGENT_ACCOUNT_OPERATIONS, GOOGLE_PROVIDER_SLUG } from '../google-operations';

const request = (method: CanonicalRequestInput['method'], url: string): CanonicalRequestInput => ({ channel: 'http-executor', method, url, headers: {}, body: new Uint8Array(0) });
const operationOf = (method: CanonicalRequestInput['method'], url: string, providerSlug: string | null = GOOGLE_PROVIDER_SLUG) => {
  const verdict = canonicalizeRequest({ request: request(method, url), providerSlug, registry: AGENT_ACCOUNT_OPERATIONS });
  return verdict.ok ? `${verdict.canonical.operation.class}/${verdict.canonical.operation.name}` : verdict.reason;
};

describe('the Google operation registry', () => {
  it('given every entry, should have no defect and no two entries matching the same request', () => {
    const actual = { defects: findRegistryEntryDefects({ registry: AGENT_ACCOUNT_OPERATIONS }), conflicts: findOperationRegistryConflicts({ registry: AGENT_ACCOUNT_OPERATIONS }) };
    expect(actual).toEqual({ defects: [], conflicts: [] });
  });

  it('given what an agent does with mail, should class reading as read, tidying as write, and sending or deleting for good as irreversible', () => {
    const actual = [
      operationOf('GET', 'https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is:unread'),
      operationOf('GET', 'https://gmail.googleapis.com/gmail/v1/users/me/messages/18c2f'),
      operationOf('POST', 'https://gmail.googleapis.com/gmail/v1/users/me/messages/18c2f/trash'),
      operationOf('POST', 'https://gmail.googleapis.com/gmail/v1/users/me/drafts'),
      operationOf('POST', 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send'),
      operationOf('POST', 'https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media'),
      operationOf('DELETE', 'https://gmail.googleapis.com/gmail/v1/users/me/messages/18c2f'),
    ];
    expect(actual).toEqual([
      'read/gmail.messages.list',
      'read/gmail.messages.get',
      'write/gmail.messages.trash',
      'write/gmail.drafts.create',
      'irreversible/gmail.messages.send',
      'irreversible/gmail.messages.send',
      'irreversible/gmail.messages.delete',
    ]);
  });

  it('given calendar and drive requests, should class anything that can reach another person (invites, files in shared folders) or not be undone as irreversible, and sharing as privilege', () => {
    const actual = [
      operationOf('GET', 'https://www.googleapis.com/calendar/v3/calendars/primary/events'),
      operationOf('POST', 'https://www.googleapis.com/calendar/v3/calendars/primary/events'),
      operationOf('DELETE', 'https://www.googleapis.com/calendar/v3/calendars/primary/events/ev1'),
      operationOf('GET', 'https://www.googleapis.com/drive/v3/files?q=name%20contains%20%27plan%27'),
      operationOf('PATCH', 'https://www.googleapis.com/drive/v3/files/f1'),
      operationOf('DELETE', 'https://www.googleapis.com/drive/v3/files/f1'),
      operationOf('POST', 'https://www.googleapis.com/drive/v3/files/f1/permissions'),
    ];
    expect(actual).toEqual([
      'read/calendar.events.list',
      'irreversible/calendar.events.insert',
      'irreversible/calendar.events.delete',
      'read/drive.files.list',
      'irreversible/drive.files.update',
      'irreversible/drive.files.delete',
      'privilege/drive.permissions.create',
    ]);
  });

  it('given a Google path no entry describes, or an account that is not a Google one, should fall back to the generic operation', () => {
    const actual = [operationOf('GET', 'https://www.googleapis.com/youtube/v3/videos'), operationOf('GET', 'https://www.googleapis.com/drive/v3/files', null)];
    expect(actual).toEqual(['unknown/generic_request', 'unknown/generic_request']);
  });
});
