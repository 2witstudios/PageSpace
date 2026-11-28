/**
 * The Google operation registry (slice 3; ADR 0004 §3.4): what an agent's
 * Google account may be asked to do, each request classed by WHAT IT DOES,
 * never by its HTTP method alone (ADR 0004 §4.3a).
 *
 * - `read`: lists and gets — mail, threads, labels, attachments, calendars,
 *   events, files, file contents, sharing settings.
 * - `write`: changes the person can undo and that reach no one else — drafts,
 *   labels, trash/untrash.
 * - `irreversible`: anything that can reach another person or cannot be taken
 *   back — sending email; creating or editing calendar events (Google can
 *   email the attendees); permanently deleting drafts, mail, events or files.
 * - `privilege`: anything that can give another person access — sharing a
 *   file (`permissions`), and EVERY Drive create, copy, upload or edit: a file
 *   placed in, or moved into (`addParents`), a folder someone else shared
 *   inherits that folder's sharing, and an edit can re-enable inherited access
 *   (`inheritedPermissionsDisabled`). The registry matches paths, not query or
 *   body, so it cannot tell the harmless edit from the sharing one: all ask,
 *   with step-up.
 *
 * A standing "allow without asking" policy can only ever cover `read` and
 * `write` (ALWAYS_ALLOWED_BY_CLASS); the rest ask a human every time. A Google
 * request no entry describes canonicalizes to `unknown/generic_request` and is
 * asked for unless the policy names it. Matching is exact over the canonical
 * origin and path template (most specific wins); `findRegistryEntryDefects`
 * and `findOperationRegistryConflicts` must both be empty (pinned by test).
 *
 * Both sides load this one constant: the authority canonicalizes and signs
 * over it, and the plane re-canonicalizes with it before it verifies.
 */
import type { CanonicalOrigin, OperationRegistry, OperationRegistryEntry } from '../canonical-request';
import type { OperationClass } from '../grant';

export const GOOGLE_PROVIDER_SLUG = 'google';
export const GMAIL_ORIGIN = 'https://gmail.googleapis.com:443' as CanonicalOrigin;
export const GOOGLE_APIS_ORIGIN = 'https://www.googleapis.com:443' as CanonicalOrigin;

type Method = OperationRegistryEntry['method'];

const entry = (origin: CanonicalOrigin, method: Method, pathTemplate: string, operationClass: OperationClass, name: string): OperationRegistryEntry => ({
  providerSlug: GOOGLE_PROVIDER_SLUG,
  origin,
  channel: 'http-executor',
  method,
  pathTemplate,
  bodySlots: [],
  derivedResources: [],
  restrictionKeys: {},
  auditResourceSlots: [],
  operation: { class: operationClass, name },
  declaredHeaders: [],
});

const gmail = (method: Method, path: string, operationClass: OperationClass, name: string) => entry(GMAIL_ORIGIN, method, `/gmail/v1/users/{userId}${path}`, operationClass, `gmail.${name}`);
const calendar = (method: Method, path: string, operationClass: OperationClass, name: string) => entry(GOOGLE_APIS_ORIGIN, method, `/calendar/v3${path}`, operationClass, `calendar.${name}`);
const drive = (method: Method, path: string, operationClass: OperationClass, name: string) => entry(GOOGLE_APIS_ORIGIN, method, path, operationClass, `drive.${name}`);

export const GOOGLE_OPERATIONS: OperationRegistry = [
  // Gmail
  gmail('GET', '/profile', 'read', 'profile.get'),
  gmail('GET', '/labels', 'read', 'labels.list'),
  gmail('GET', '/messages', 'read', 'messages.list'),
  gmail('GET', '/messages/{messageId}', 'read', 'messages.get'),
  gmail('GET', '/messages/{messageId}/attachments/{attachmentId}', 'read', 'attachments.get'),
  gmail('GET', '/threads', 'read', 'threads.list'),
  gmail('GET', '/threads/{threadId}', 'read', 'threads.get'),
  gmail('GET', '/drafts', 'read', 'drafts.list'),
  gmail('GET', '/drafts/{draftId}', 'read', 'drafts.get'),
  gmail('POST', '/drafts', 'write', 'drafts.create'),
  gmail('PUT', '/drafts/{draftId}', 'write', 'drafts.update'),
  gmail('DELETE', '/drafts/{draftId}', 'irreversible', 'drafts.delete'),
  gmail('POST', '/messages/{messageId}/modify', 'write', 'messages.modify'),
  gmail('POST', '/threads/{threadId}/modify', 'write', 'threads.modify'),
  gmail('POST', '/messages/{messageId}/trash', 'write', 'messages.trash'),
  gmail('POST', '/messages/{messageId}/untrash', 'write', 'messages.untrash'),
  gmail('POST', '/messages/send', 'irreversible', 'messages.send'),
  gmail('POST', '/drafts/send', 'irreversible', 'drafts.send'),
  gmail('DELETE', '/messages/{messageId}', 'irreversible', 'messages.delete'),
  gmail('DELETE', '/threads/{threadId}', 'irreversible', 'threads.delete'),
  entry(GMAIL_ORIGIN, 'POST', '/upload/gmail/v1/users/{userId}/messages/send', 'irreversible', 'gmail.messages.send'),
  // Calendar
  calendar('GET', '/users/me/calendarList', 'read', 'calendarList.list'),
  calendar('GET', '/calendars/{calendarId}', 'read', 'calendars.get'),
  calendar('GET', '/calendars/{calendarId}/events', 'read', 'events.list'),
  calendar('GET', '/calendars/{calendarId}/events/{eventId}', 'read', 'events.get'),
  calendar('POST', '/calendars/{calendarId}/events', 'irreversible', 'events.insert'),
  calendar('PATCH', '/calendars/{calendarId}/events/{eventId}', 'irreversible', 'events.patch'),
  calendar('PUT', '/calendars/{calendarId}/events/{eventId}', 'irreversible', 'events.update'),
  calendar('DELETE', '/calendars/{calendarId}/events/{eventId}', 'irreversible', 'events.delete'),
  calendar('POST', '/freeBusy', 'read', 'freebusy.query'),
  // Drive
  drive('GET', '/drive/v3/about', 'read', 'about.get'),
  drive('GET', '/drive/v3/files', 'read', 'files.list'),
  drive('GET', '/drive/v3/files/{fileId}', 'read', 'files.get'),
  drive('GET', '/drive/v3/files/{fileId}/export', 'read', 'files.export'),
  drive('GET', '/drive/v3/files/{fileId}/permissions', 'read', 'permissions.list'),
  drive('POST', '/drive/v3/files', 'privilege', 'files.create'),
  drive('POST', '/drive/v3/files/{fileId}/copy', 'privilege', 'files.copy'),
  drive('PATCH', '/drive/v3/files/{fileId}', 'privilege', 'files.update'),
  drive('POST', '/upload/drive/v3/files', 'privilege', 'files.upload'),
  drive('PATCH', '/upload/drive/v3/files/{fileId}', 'privilege', 'files.uploadUpdate'),
  drive('DELETE', '/drive/v3/files/{fileId}', 'irreversible', 'files.delete'),
  drive('POST', '/drive/v3/files/{fileId}/permissions', 'privilege', 'permissions.create'),
  drive('DELETE', '/drive/v3/files/{fileId}/permissions/{permissionId}', 'privilege', 'permissions.delete'),
];

/** The API origins a Google account can ever be pinned to: an edit can narrow them, never add another site. */
export const GOOGLE_ORIGINS: readonly CanonicalOrigin[] = [GMAIL_ORIGIN, GOOGLE_APIS_ORIGIN];

/** Every registry the authority and the plane load. One constant, both sides, or every digest differs. */
export const AGENT_ACCOUNT_OPERATIONS: OperationRegistry = [...GOOGLE_OPERATIONS];
