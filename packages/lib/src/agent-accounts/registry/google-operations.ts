/**
 * The Google operation registry (slice 3; ADR 0004 §3.4): what an agent's
 * Google account may be asked to do, each request classed by WHAT IT DOES,
 * never by its HTTP method alone (ADR 0004 §4.3a).
 *
 * - `read`: lists and gets — mail, threads, labels, attachments, calendars,
 *   events, files, file contents, sharing settings.
 * - `write`: changes the person can undo — drafts, labels, trash/untrash,
 *   creating or editing events and files.
 * - `irreversible`: sending email (a sent message cannot be recalled),
 *   permanently deleting mail, events or files.
 * - `privilege`: sharing a Drive file with someone (`permissions` create) — it
 *   grants another person access, so it always asks, with step-up.
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
  gmail('DELETE', '/drafts/{draftId}', 'write', 'drafts.delete'),
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
  calendar('POST', '/calendars/{calendarId}/events', 'write', 'events.insert'),
  calendar('PATCH', '/calendars/{calendarId}/events/{eventId}', 'write', 'events.patch'),
  calendar('PUT', '/calendars/{calendarId}/events/{eventId}', 'write', 'events.update'),
  calendar('DELETE', '/calendars/{calendarId}/events/{eventId}', 'irreversible', 'events.delete'),
  calendar('POST', '/freeBusy', 'read', 'freebusy.query'),
  // Drive
  drive('GET', '/drive/v3/about', 'read', 'about.get'),
  drive('GET', '/drive/v3/files', 'read', 'files.list'),
  drive('GET', '/drive/v3/files/{fileId}', 'read', 'files.get'),
  drive('GET', '/drive/v3/files/{fileId}/export', 'read', 'files.export'),
  drive('GET', '/drive/v3/files/{fileId}/permissions', 'read', 'permissions.list'),
  drive('POST', '/drive/v3/files', 'write', 'files.create'),
  drive('POST', '/drive/v3/files/{fileId}/copy', 'write', 'files.copy'),
  drive('PATCH', '/drive/v3/files/{fileId}', 'write', 'files.update'),
  drive('POST', '/upload/drive/v3/files', 'write', 'files.upload'),
  drive('PATCH', '/upload/drive/v3/files/{fileId}', 'write', 'files.uploadUpdate'),
  drive('DELETE', '/drive/v3/files/{fileId}', 'irreversible', 'files.delete'),
  drive('POST', '/drive/v3/files/{fileId}/permissions', 'privilege', 'permissions.create'),
  drive('DELETE', '/drive/v3/files/{fileId}/permissions/{permissionId}', 'privilege', 'permissions.delete'),
];

/** Every registry the authority and the plane load. One constant, both sides, or every digest differs. */
export const AGENT_ACCOUNT_OPERATIONS: OperationRegistry = [...GOOGLE_OPERATIONS];
