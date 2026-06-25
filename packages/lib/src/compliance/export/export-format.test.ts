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
});

describe('buildPortableExportFiles', () => {
  it('given_data_returnsSingleSchemaOrgDataJson', () => {
    const files = buildPortableExportFiles(makeData());
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe('data.json');
    expect((files[0].data as Record<string, unknown>)['@context']).toBe('https://schema.org');
  });
});
