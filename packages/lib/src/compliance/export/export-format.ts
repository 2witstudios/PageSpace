/**
 * GDPR export formatting — pure transforms over collected user data.
 *
 * No I/O. Given an in-memory `AllUserData` snapshot, these functions build:
 *  - the native per-section file inventory,
 *  - a versioned `manifest.json` documenting the bundle (schema version + files),
 *  - a documented, interoperable portable representation (schema.org), and
 *  - the format selector for the `?format=` switch.
 *
 * The export route is a thin edge: it collects data, calls these, and streams
 * the result into a ZIP via `archiver`.
 */

import type { AllUserData } from './gdpr-export';

/** Bump when the export bundle's structure/inventory changes. */
export const EXPORT_SCHEMA_VERSION = '1.0.0';

export type ExportFormat = 'native' | 'portable';

/** One serializable file in the export bundle. */
export interface ExportFile {
  name: string;
  description: string;
  recordCount: number;
  data: unknown;
}

export interface ExportManifestFileEntry {
  name: string;
  description: string;
  recordCount: number;
}

export interface ExportManifest {
  schemaVersion: string;
  generator: string;
  exportedAt: string;
  format: ExportFormat;
  files: ExportManifestFileEntry[];
}

/**
 * Resolve the requested export format. Anything other than the documented
 * `portable` value (including null/unknown) resolves to `native`.
 */
export function parseExportFormat(param: string | null | undefined): ExportFormat {
  return param === 'portable' ? 'portable' : 'native';
}

/**
 * The native bundle: one JSON file per data category. `recordCount` is the
 * array length for collections and 1 for the singular profile/personalization.
 * `personalization.json` is omitted entirely when the user has none.
 */
export function buildNativeExportFiles(data: AllUserData): ExportFile[] {
  const files: ExportFile[] = [
    { name: 'profile.json', description: 'User account profile', recordCount: 1, data: data.profile },
    { name: 'drives.json', description: 'Drives owned or joined', recordCount: data.drives.length, data: data.drives },
    { name: 'pages.json', description: 'Pages across your drives', recordCount: data.pages.length, data: data.pages },
    { name: 'messages.json', description: 'Chat, channel, conversation and direct messages', recordCount: data.messages.length, data: data.messages },
    { name: 'files-metadata.json', description: 'Uploaded file metadata', recordCount: data.files.length, data: data.files },
    { name: 'activity.json', description: 'Activity / audit trail entries', recordCount: data.activity.length, data: data.activity },
    { name: 'ai-usage.json', description: 'AI usage records', recordCount: data.aiUsage.length, data: data.aiUsage },
    { name: 'tasks.json', description: 'Task lists and items', recordCount: data.tasks.length, data: data.tasks },
    { name: 'sessions.json', description: 'Authentication sessions', recordCount: data.sessions.length, data: data.sessions },
    { name: 'notifications.json', description: 'Notifications', recordCount: data.notifications.length, data: data.notifications },
    { name: 'display-preferences.json', description: 'Display preferences', recordCount: data.displayPreferences.length, data: data.displayPreferences },
  ];
  if (data.personalization) {
    files.push({ name: 'personalization.json', description: 'Personalization settings', recordCount: 1, data: data.personalization });
  }
  return files;
}

/**
 * Build the manifest from the actual file set being shipped. The manifest
 * documents the schema version and the inventory so the recipient can interpret
 * the bundle without out-of-band knowledge (GDPR Art 20 portability).
 */
export function buildExportManifest(
  files: ExportFile[],
  opts: { exportedAt: Date; format: ExportFormat },
): ExportManifest {
  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    generator: 'PageSpace GDPR export',
    exportedAt: opts.exportedAt.toISOString(),
    format: opts.format,
    files: files.map((f) => ({ name: f.name, description: f.description, recordCount: f.recordCount })),
  };
}

function toIso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

/**
 * Map the collected data onto a documented, interoperable schema.org structure
 * (https://schema.org): the data subject as a `Person`, with drives/pages as
 * `CreativeWork`, messages as `Message`, and files as `MediaObject`. The
 * remaining operational categories (activity, AI usage, tasks, sessions,
 * notifications, display preferences, personalization) are carried verbatim as
 * `PropertyValue` entries so the portable bundle is **complete** — no data
 * category is dropped (GDPR Art 20). Dates are ISO-8601 strings (mapped fields
 * explicitly; values inside `additionalProperty` serialize to ISO-8601 via
 * JSON). Empty sections become empty arrays rather than throwing.
 */
export function toPortableExport(data: AllUserData): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'Person',
    identifier: data.profile.id,
    name: data.profile.name,
    email: data.profile.email,
    image: data.profile.image ?? null,
    // Native field kept (no schema.org equivalent) so the portable export is
    // field-for-field complete with the native export (GDPR Art 20).
    timezone: data.profile.timezone ?? null,
    dateCreated: toIso(data.profile.createdAt),
    dateModified: toIso(data.profile.updatedAt),
    owns: data.drives.map((d) => ({
      '@type': 'CreativeWork',
      identifier: d.id,
      name: d.name,
      roleName: d.role,
      slug: d.slug,
      dateCreated: toIso(d.createdAt),
    })),
    creativeWork: data.pages.map((p) => ({
      '@type': 'CreativeWork',
      identifier: p.id,
      name: p.title,
      additionalType: p.type,
      text: p.content,
      isPartOf: p.driveId,
      dateCreated: toIso(p.createdAt),
      dateModified: toIso(p.updatedAt),
    })),
    message: data.messages.map((m) => ({
      '@type': 'Message',
      identifier: m.id,
      text: m.content,
      messageAttachment: m.source,
      // Native fields kept verbatim (no schema.org equivalents) for completeness.
      direction: m.direction ?? null,
      sender: m.role ?? null,
      pageId: m.pageId ?? null,
      conversationId: m.conversationId ?? null,
      isActive: m.isActive ?? null,
      dateDeleted: toIso(m.deletedAt ?? null),
      dateSent: toIso(m.createdAt),
    })),
    subjectOf: data.files.map((f) => ({
      '@type': 'MediaObject',
      identifier: f.id,
      encodingFormat: f.mimeType,
      contentSize: f.sizeBytes,
      contentUrl: f.storagePath,
      isPartOf: f.driveId,
      dateCreated: toIso(f.createdAt),
    })),
    // Complete-but-not-natively-typed categories, kept verbatim so the portable
    // bundle loses nothing relative to the native export.
    additionalProperty: [
      { '@type': 'PropertyValue', name: 'activity', value: data.activity },
      { '@type': 'PropertyValue', name: 'aiUsage', value: data.aiUsage },
      { '@type': 'PropertyValue', name: 'tasks', value: data.tasks },
      { '@type': 'PropertyValue', name: 'sessions', value: data.sessions },
      { '@type': 'PropertyValue', name: 'notifications', value: data.notifications },
      { '@type': 'PropertyValue', name: 'displayPreferences', value: data.displayPreferences },
      { '@type': 'PropertyValue', name: 'personalization', value: data.personalization },
    ],
  };
}

/**
 * The portable bundle: a single self-describing `data.json` plus its manifest.
 */
export function buildPortableExportFiles(data: AllUserData): ExportFile[] {
  return [
    {
      name: 'data.json',
      description: 'All user data in schema.org portable format (https://schema.org)',
      recordCount: 1,
      data: toPortableExport(data),
    },
  ];
}
