import { describe, it, expect } from 'vitest';
import type { AllUserData } from './gdpr-export';
import {
  EXPORT_SCHEMA_VERSION,
  parseExportFormat,
  buildNativeExportFiles,
  buildExportManifest,
  buildPortableExportFiles,
  toPortableExport,
} from './export-format';

const D1 = new Date('2024-01-02T03:04:05.000Z');
const D2 = new Date('2024-02-03T04:05:06.000Z');

function makeData(overrides: Partial<AllUserData> = {}): AllUserData {
  return {
    profile: {
      id: 'u1',
      name: 'Ada',
      email: 'ada@example.com',
      image: null,
      timezone: 'UTC',
      createdAt: D1,
      updatedAt: D2,
    },
    drives: [{ id: 'd1', name: 'Drive One', slug: 'drive-one', role: 'OWNER', createdAt: D1 }],
    pages: [
      { id: 'p1', title: 'Page One', type: 'DOCUMENT', content: 'hello', driveId: 'd1', createdAt: D1, updatedAt: D2 },
      { id: 'p2', title: 'Page Two', type: 'CANVAS', content: '{}', driveId: 'd1', createdAt: D1, updatedAt: D2 },
    ],
    messages: [{ id: 'm1', source: 'channel', content: 'hi', createdAt: D1 }],
    files: [],
    activity: [],
    aiUsage: [],
    tasks: [],
    sessions: [],
    notifications: [],
    displayPreferences: [],
    personalization: null,
    ...overrides,
  };
}

describe('parseExportFormat', () => {
  it('given_noOrUnknownOrNative_resolvesToNative', () => {
    expect(parseExportFormat(undefined)).toBe('native');
    expect(parseExportFormat(null)).toBe('native');
    expect(parseExportFormat('native')).toBe('native');
    expect(parseExportFormat('weird')).toBe('native');
  });

  it('given_portable_resolvesToPortable', () => {
    expect(parseExportFormat('portable')).toBe('portable');
  });
});

describe('buildNativeExportFiles', () => {
  it('given_collections_reportsArrayLengthsAndSingularProfileAsOne', () => {
    const files = buildNativeExportFiles(makeData());
    const byName = Object.fromEntries(files.map((f) => [f.name, f.recordCount]));

    expect(byName['profile.json']).toBe(1);
    expect(byName['pages.json']).toBe(2);
    expect(byName['drives.json']).toBe(1);
    expect(byName['messages.json']).toBe(1);
    expect(byName['files-metadata.json']).toBe(0);
  });

  it('given_nullPersonalization_omitsItFromInventory', () => {
    const files = buildNativeExportFiles(makeData({ personalization: null }));
    expect(files.some((f) => f.name === 'personalization.json')).toBe(false);
  });

  it('given_presentPersonalization_includesItWithCountOne', () => {
    const files = buildNativeExportFiles(
      makeData({
        personalization: {
          bio: 'b',
          writingStyle: null,
          rules: null,
          enabled: true,
          createdAt: D1,
          updatedAt: D2,
        },
      }),
    );
    const entry = files.find((f) => f.name === 'personalization.json');
    expect(entry?.recordCount).toBe(1);
  });
});

describe('buildExportManifest', () => {
  it('given_filesAndDate_returnsVersionedManifestWithInventory', () => {
    const files = buildNativeExportFiles(makeData());
    const manifest = buildExportManifest(files, { exportedAt: D1, format: 'native' });

    expect(manifest.schemaVersion).toBe(EXPORT_SCHEMA_VERSION);
    expect(manifest.exportedAt).toBe('2024-01-02T03:04:05.000Z');
    expect(manifest.format).toBe('native');
    expect(manifest.generator).toContain('PageSpace');
    const pages = manifest.files.find((f) => f.name === 'pages.json');
    expect(pages).toEqual({ name: 'pages.json', description: expect.any(String), recordCount: 2 });
    // inventory does not leak the raw data payload
    expect(JSON.stringify(manifest)).not.toContain('hello');
  });
});

describe('toPortableExport', () => {
  it('given_data_mapsProfileToPersonPagesToCreativeWorkMessagesToMessage', () => {
    const portable = toPortableExport(makeData());

    expect(portable['@context']).toBe('https://schema.org');
    expect(portable['@type']).toBe('Person');
    expect(portable.email).toBe('ada@example.com');

    const creativeWork = portable.creativeWork as Array<Record<string, unknown>>;
    expect(creativeWork).toHaveLength(2);
    expect(creativeWork[0]['@type']).toBe('CreativeWork');
    expect(creativeWork[0].name).toBe('Page One');

    const messages = portable.message as Array<Record<string, unknown>>;
    expect(messages[0]['@type']).toBe('Message');
    expect(messages[0].text).toBe('hi');
  });

  it('given_dates_serializesAsIso8601Strings', () => {
    const portable = toPortableExport(makeData());
    expect(portable.dateCreated).toBe('2024-01-02T03:04:05.000Z');
    const creativeWork = portable.creativeWork as Array<Record<string, unknown>>;
    expect(creativeWork[0].dateModified).toBe('2024-02-03T04:05:06.000Z');
  });

  it('given_emptySections_producesEmptyArraysNotThrows', () => {
    const portable = toPortableExport(makeData({ pages: [], messages: [], drives: [] }));
    expect(portable.creativeWork).toEqual([]);
    expect(portable.message).toEqual([]);
    expect(portable.owns).toEqual([]);
  });

  it('given_files_mapsToMediaObject', () => {
    const portable = toPortableExport(
      makeData({
        files: [
          { id: 'f1', driveId: 'd1', sizeBytes: 1234, mimeType: 'image/png', storagePath: 'path/f1', createdAt: D1 },
        ],
      }),
    );
    const media = portable.subjectOf as Array<Record<string, unknown>>;
    expect(media).toHaveLength(1);
    expect(media[0]['@type']).toBe('MediaObject');
    expect(media[0].encodingFormat).toBe('image/png');
    expect(media[0].contentSize).toBe(1234);
  });

  it('is field-level lossless: native fields without a schema.org slot are preserved', () => {
    const portable = toPortableExport(
      makeData({
        messages: [
          {
            id: 'm1',
            source: 'direct_message',
            content: 'hi',
            direction: 'sent',
            role: 'user',
            pageId: 'pg1',
            conversationId: 'c1',
            isActive: true,
            deletedAt: D2,
            createdAt: D1,
          },
        ],
      }),
    );

    // profile.timezone and drive.slug have no schema.org equivalent but must survive
    expect(portable.timezone).toBe('UTC');
    const owns = portable.owns as Array<Record<string, unknown>>;
    expect(owns[0].slug).toBe('drive-one');

    const msg = (portable.message as Array<Record<string, unknown>>)[0];
    expect(msg.direction).toBe('sent');
    expect(msg.sender).toBe('user');
    expect(msg.pageId).toBe('pg1');
    expect(msg.conversationId).toBe('c1');
    expect(msg.isActive).toBe(true);
    expect(msg.dateDeleted).toBe('2024-02-03T04:05:06.000Z');
  });

  it('is lossless: every native data category is represented (GDPR Art 20)', () => {
    const full = makeData({
      files: [{ id: 'f1', driveId: 'd1', sizeBytes: 1, mimeType: null, storagePath: null, createdAt: D1 }],
      activity: [{ id: 'a1', operation: 'create', resourceType: 'page', resourceId: 'p1', timestamp: D1, metadata: null }],
      aiUsage: [{ id: 'ai1', provider: 'openrouter', model: 'm', inputTokens: 1, outputTokens: 2, cost: 0.1, timestamp: D1 }],
      tasks: [{ listId: 'l1', listTitle: 'L', items: [] }],
      sessions: [{ id: 's1', type: 'session', deviceId: null, scopes: [], createdByIp: null, lastUsedAt: null, lastUsedIp: null, expiresAt: D2, revokedAt: null, revokedReason: null, createdAt: D1 }],
      notifications: [{ id: 'n1', type: 't', title: 'T', message: 'M', metadata: null, isRead: false, createdAt: D1, readAt: null }],
      displayPreferences: [{ preferenceType: 'theme', enabled: true, updatedAt: D2 }],
      personalization: { bio: 'b', writingStyle: null, rules: null, enabled: true, createdAt: D1, updatedAt: D2 },
    });
    const portable = toPortableExport(full);

    // schema.org-typed categories
    expect((portable.owns as unknown[]).length).toBe(1);
    expect((portable.creativeWork as unknown[]).length).toBe(2);
    expect((portable.message as unknown[]).length).toBe(1);
    expect((portable.subjectOf as unknown[]).length).toBe(1);

    // everything else carried verbatim under additionalProperty
    const props = portable.additionalProperty as Array<{ name: string; value: unknown }>;
    const byName = Object.fromEntries(props.map((p) => [p.name, p.value]));
    for (const key of ['activity', 'aiUsage', 'tasks', 'sessions', 'notifications', 'displayPreferences', 'personalization']) {
      expect(byName).toHaveProperty(key);
    }
    expect((byName.activity as unknown[]).length).toBe(1);
    expect((byName.sessions as unknown[]).length).toBe(1);
    expect(byName.personalization).not.toBeNull();
  });
});

describe('buildPortableExportFiles', () => {
  it('given_data_returnsSingleSchemaOrgDataJson', () => {
    const files = buildPortableExportFiles(makeData());
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe('data.json');
    expect((files[0].data as Record<string, unknown>)['@context']).toBe('https://schema.org');
  });
});
