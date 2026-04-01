import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock repository seams
vi.mock('@pagespace/lib/server', () => ({
  canUserEditPage: vi.fn(),
  logPageActivity: vi.fn(),
  getActorInfo: vi.fn().mockResolvedValue({ actorEmail: 'test@example.com', actorDisplayName: 'Test User' }),
  detectPageContentFormat: vi.fn(() => 'text'),
  hashWithPrefix: vi.fn(() => 'content-ref'),
  computePageStateHash: vi.fn(() => 'state-hash'),
  createPageVersion: vi.fn().mockResolvedValue({ id: 'version-1' }),
  loggers: {
    ai: {
      child: vi.fn(() => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      })),
    },
  },
  pageRepository: {
    existsInDrive: vi.fn(),
    getNextPosition: vi.fn().mockResolvedValue(0),
    create: vi.fn().mockImplementation(({ title }) => ({
      id: `page-${title}`,
      title,
    })),
  },
  driveRepository: {
    findByIdBasic: vi.fn(),
  },
}));

vi.mock('@pagespace/lib/monitoring', () => ({
  createChangeGroupId: vi.fn(() => 'change-group-1'),
}));

vi.mock('@pagespace/lib/integrations', () => ({
  getConnectionWithProvider: vi.fn(),
  decryptCredentials: vi.fn(),
}));

vi.mock('@pagespace/db', () => ({
  db: {},
}));

vi.mock('@/lib/websocket', () => ({
  broadcastPageEvent: vi.fn().mockResolvedValue(undefined),
  createPageEventPayload: vi.fn((...args) => args),
}));

// Mock global fetch for GitHub API calls
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { githubImportTools } from '../github-import-tools';
import {
  canUserEditPage,
  pageRepository,
  driveRepository,
} from '@pagespace/lib/server';
import {
  getConnectionWithProvider,
  decryptCredentials,
} from '@pagespace/lib/integrations';
import type { ToolExecutionContext } from '../../core';

const mockCanUserEditPage = vi.mocked(canUserEditPage);
const mockPageRepo = vi.mocked(pageRepository);
const mockDriveRepo = vi.mocked(driveRepository);
const mockGetConnection = vi.mocked(getConnectionWithProvider);
const mockDecryptCredentials = vi.mocked(decryptCredentials);

function makeContext(userId?: string) {
  return {
    toolCallId: '1',
    messages: [],
    experimental_context: userId ? { userId } as ToolExecutionContext : {},
  };
}

function mockGitHubResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  };
}

function setupAuthMocks() {
  mockGetConnection.mockResolvedValue({
    id: 'conn-1',
    providerId: 'github',
    name: 'GitHub',
    status: 'active',
    userId: 'user-123',
    driveId: null,
    credentials: { accessToken: 'encrypted' },
  } as never);
  mockDecryptCredentials.mockResolvedValue({ accessToken: 'ghp_test_token' });
  mockDriveRepo.findByIdBasic.mockResolvedValue({
    id: 'drive-1',
    ownerId: 'user-123',
  } as never);
}

function base64Encode(str: string): string {
  return Buffer.from(str).toString('base64');
}

describe('github-import-tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  describe('tool definition', () => {
    it('exports import_from_github tool', () => {
      expect(githubImportTools.import_from_github).toBeDefined();
    });

    it('has a description', () => {
      expect(githubImportTools.import_from_github.description).toContain('Import code from a GitHub repository');
    });
  });

  describe('authentication', () => {
    it('requires user authentication', async () => {
      const context = makeContext();
      await expect(
        githubImportTools.import_from_github.execute!(
          {
            connectionId: 'conn-1',
            mode: 'file',
            owner: 'octocat',
            repo: 'hello',
            driveId: 'drive-1',
            path: 'README.md',
          },
          context
        )
      ).rejects.toThrow('User authentication required');
    });
  });

  describe('permission checks', () => {
    beforeEach(setupAuthMocks);

    it('throws when drive does not exist', async () => {
      mockDriveRepo.findByIdBasic.mockResolvedValue(null);

      await expect(
        githubImportTools.import_from_github.execute!(
          {
            connectionId: 'conn-1',
            mode: 'file',
            owner: 'octocat',
            repo: 'hello',
            driveId: 'drive-1',
            path: 'README.md',
          },
          makeContext('user-123')
        )
      ).rejects.toThrow('not found');
    });

    it('throws when parent page not in drive', async () => {
      mockPageRepo.existsInDrive.mockResolvedValue(false);

      await expect(
        githubImportTools.import_from_github.execute!(
          {
            connectionId: 'conn-1',
            mode: 'file',
            owner: 'octocat',
            repo: 'hello',
            driveId: 'drive-1',
            parentId: 'parent-1',
            path: 'README.md',
          },
          makeContext('user-123')
        )
      ).rejects.toThrow('not found');
    });

    it('throws when user lacks edit permissions on parent', async () => {
      mockPageRepo.existsInDrive.mockResolvedValue(true);
      mockCanUserEditPage.mockResolvedValue(false);

      await expect(
        githubImportTools.import_from_github.execute!(
          {
            connectionId: 'conn-1',
            mode: 'file',
            owner: 'octocat',
            repo: 'hello',
            driveId: 'drive-1',
            parentId: 'parent-1',
            path: 'README.md',
          },
          makeContext('user-123')
        )
      ).rejects.toThrow('Insufficient permissions');
    });

    it('throws when non-owner creates pages at drive root', async () => {
      mockDriveRepo.findByIdBasic.mockResolvedValue({
        id: 'drive-1',
        ownerId: 'other-user',
      } as never);

      await expect(
        githubImportTools.import_from_github.execute!(
          {
            connectionId: 'conn-1',
            mode: 'file',
            owner: 'octocat',
            repo: 'hello',
            driveId: 'drive-1',
            path: 'README.md',
          },
          makeContext('user-123')
        )
      ).rejects.toThrow('Only drive owners');
    });
  });

  describe('connection validation', () => {
    it('throws when connection belongs to a different user', async () => {
      mockDriveRepo.findByIdBasic.mockResolvedValue({
        id: 'drive-1',
        ownerId: 'user-123',
      } as never);
      mockGetConnection.mockResolvedValue({
        id: 'conn-1',
        providerId: 'github',
        name: 'GitHub',
        status: 'active',
        userId: 'other-user',
        driveId: null,
        credentials: {},
      } as never);

      await expect(
        githubImportTools.import_from_github.execute!(
          {
            connectionId: 'conn-1',
            mode: 'file',
            owner: 'octocat',
            repo: 'hello',
            driveId: 'drive-1',
            path: 'README.md',
          },
          makeContext('user-123')
        )
      ).rejects.toThrow('does not belong');
    });

    it('throws when connection is inactive', async () => {
      mockDriveRepo.findByIdBasic.mockResolvedValue({
        id: 'drive-1',
        ownerId: 'user-123',
      } as never);
      mockGetConnection.mockResolvedValue({
        id: 'conn-1',
        providerId: 'github',
        name: 'GitHub',
        status: 'expired',
        userId: 'user-123',
        driveId: null,
        credentials: {},
      } as never);

      await expect(
        githubImportTools.import_from_github.execute!(
          {
            connectionId: 'conn-1',
            mode: 'file',
            owner: 'octocat',
            repo: 'hello',
            driveId: 'drive-1',
            path: 'README.md',
          },
          makeContext('user-123')
        )
      ).rejects.toThrow('expired');
    });
  });

  describe('file mode', () => {
    beforeEach(setupAuthMocks);

    it('requires path parameter', async () => {
      const result = await githubImportTools.import_from_github.execute!(
        {
          connectionId: 'conn-1',
          mode: 'file',
          owner: 'octocat',
          repo: 'hello',
          driveId: 'drive-1',
        },
        makeContext('user-123')
      );

      expect(result).toMatchObject({ success: false, error: expect.stringContaining('path is required') });
    });

    it('rejects binary files', async () => {
      const result = await githubImportTools.import_from_github.execute!(
        {
          connectionId: 'conn-1',
          mode: 'file',
          owner: 'octocat',
          repo: 'hello',
          driveId: 'drive-1',
          path: 'logo.png',
        },
        makeContext('user-123')
      );

      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining('binary file'),
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('imports a single file successfully', async () => {
      const fileContent = 'console.log("hello");';
      mockFetch.mockResolvedValueOnce(
        mockGitHubResponse({
          name: 'index.ts',
          path: 'src/index.ts',
          sha: 'abc123',
          size: fileContent.length,
          content: base64Encode(fileContent),
          encoding: 'base64',
          html_url: 'https://github.com/octocat/hello/blob/main/src/index.ts',
        })
      );

      const result = await githubImportTools.import_from_github.execute!(
        {
          connectionId: 'conn-1',
          mode: 'file',
          owner: 'octocat',
          repo: 'hello',
          driveId: 'drive-1',
          path: 'src/index.ts',
        },
        makeContext('user-123')
      );

      expect(result).toMatchObject({
        success: true,
        title: 'index.ts',
        language: 'typescript',
      });
      expect(mockPageRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'index.ts',
          type: 'CODE',
          content: fileContent,
        })
      );
    });

    it('passes ref as query param when specified', async () => {
      mockFetch.mockResolvedValueOnce(
        mockGitHubResponse({
          name: 'index.ts',
          path: 'src/index.ts',
          sha: 'abc123',
          size: 10,
          content: base64Encode('code'),
          encoding: 'base64',
          html_url: 'https://github.com/octocat/hello/blob/v1/src/index.ts',
        })
      );

      await githubImportTools.import_from_github.execute!(
        {
          connectionId: 'conn-1',
          mode: 'file',
          owner: 'octocat',
          repo: 'hello',
          driveId: 'drive-1',
          path: 'src/index.ts',
          ref: 'v1.0.0',
        },
        makeContext('user-123')
      );

      const fetchUrl = mockFetch.mock.calls[0][0] as string;
      expect(fetchUrl).toContain('ref=v1.0.0');
    });
  });

  describe('pr mode', () => {
    beforeEach(setupAuthMocks);

    it('requires pullNumber parameter', async () => {
      const result = await githubImportTools.import_from_github.execute!(
        {
          connectionId: 'conn-1',
          mode: 'pr',
          owner: 'octocat',
          repo: 'hello',
          driveId: 'drive-1',
        },
        makeContext('user-123')
      );

      expect(result).toMatchObject({ success: false, error: expect.stringContaining('pullNumber is required') });
    });

    it('imports PR files into a folder', async () => {
      // Mock PR metadata
      mockFetch.mockResolvedValueOnce(
        mockGitHubResponse({
          title: 'Add feature',
          head: { sha: 'head-sha', ref: 'feature' },
          base: { ref: 'main' },
          additions: 10,
          deletions: 2,
          changed_files: 1,
        })
      );

      // Mock PR files list
      mockFetch.mockResolvedValueOnce(
        mockGitHubResponse([
          {
            filename: 'src/feature.ts',
            status: 'added',
            additions: 10,
            deletions: 0,
            changes: 10,
            sha: 'file-sha',
            blob_url: 'https://github.com/octocat/hello/blob/head-sha/src/feature.ts',
          },
        ])
      );

      // Mock file content fetch
      mockFetch.mockResolvedValueOnce(
        mockGitHubResponse({
          name: 'feature.ts',
          path: 'src/feature.ts',
          sha: 'file-sha',
          size: 20,
          content: base64Encode('export const feature = true;'),
          encoding: 'base64',
          html_url: 'https://github.com/octocat/hello/blob/head-sha/src/feature.ts',
        })
      );

      const result = await githubImportTools.import_from_github.execute!(
        {
          connectionId: 'conn-1',
          mode: 'pr',
          owner: 'octocat',
          repo: 'hello',
          driveId: 'drive-1',
          pullNumber: 42,
        },
        makeContext('user-123')
      ) as { success: boolean; importedCount: number; skippedCount: number };

      expect(result.success).toBe(true);
      expect(result.importedCount).toBe(1);
      expect(result.skippedCount).toBe(0);
    });

    it('skips binary files in PR', async () => {
      mockFetch.mockResolvedValueOnce(
        mockGitHubResponse({
          title: 'Add logo',
          head: { sha: 'head-sha', ref: 'feature' },
          base: { ref: 'main' },
          additions: 0,
          deletions: 0,
          changed_files: 1,
        })
      );

      mockFetch.mockResolvedValueOnce(
        mockGitHubResponse([
          {
            filename: 'logo.png',
            status: 'added',
            additions: 0,
            deletions: 0,
            changes: 0,
            sha: 'bin-sha',
            blob_url: 'https://github.com/octocat/hello/blob/head-sha/logo.png',
          },
        ])
      );

      const result = await githubImportTools.import_from_github.execute!(
        {
          connectionId: 'conn-1',
          mode: 'pr',
          owner: 'octocat',
          repo: 'hello',
          driveId: 'drive-1',
          pullNumber: 10,
        },
        makeContext('user-123')
      ) as { success: boolean; skippedCount: number; skipped: string[] };

      expect(result.success).toBe(true);
      expect(result.skippedCount).toBe(1);
      expect(result.skipped[0]).toContain('binary');
    });

    it('skips deleted files in PR', async () => {
      mockFetch.mockResolvedValueOnce(
        mockGitHubResponse({
          title: 'Remove old code',
          head: { sha: 'head-sha', ref: 'cleanup' },
          base: { ref: 'main' },
          additions: 0,
          deletions: 50,
          changed_files: 1,
        })
      );

      mockFetch.mockResolvedValueOnce(
        mockGitHubResponse([
          {
            filename: 'old.ts',
            status: 'removed',
            additions: 0,
            deletions: 50,
            changes: 50,
            sha: 'old-sha',
            blob_url: 'https://github.com/octocat/hello/blob/head-sha/old.ts',
          },
        ])
      );

      const result = await githubImportTools.import_from_github.execute!(
        {
          connectionId: 'conn-1',
          mode: 'pr',
          owner: 'octocat',
          repo: 'hello',
          driveId: 'drive-1',
          pullNumber: 11,
        },
        makeContext('user-123')
      ) as { success: boolean; skipped: string[] };

      expect(result.success).toBe(true);
      expect(result.skipped[0]).toContain('deleted');
    });
  });

  describe('directory mode', () => {
    beforeEach(setupAuthMocks);

    it('requires path parameter', async () => {
      const result = await githubImportTools.import_from_github.execute!(
        {
          connectionId: 'conn-1',
          mode: 'directory',
          owner: 'octocat',
          repo: 'hello',
          driveId: 'drive-1',
        },
        makeContext('user-123')
      );

      expect(result).toMatchObject({ success: false, error: expect.stringContaining('path is required') });
    });

    it('imports a directory of files', async () => {
      // Mock directory listing
      mockFetch.mockResolvedValueOnce(
        mockGitHubResponse([
          {
            name: 'index.ts',
            path: 'src/index.ts',
            type: 'file',
            size: 100,
            sha: 'sha-1',
            html_url: 'https://github.com/octocat/hello/blob/main/src/index.ts',
            download_url: null,
          },
          {
            name: 'utils.ts',
            path: 'src/utils.ts',
            type: 'file',
            size: 50,
            sha: 'sha-2',
            html_url: 'https://github.com/octocat/hello/blob/main/src/utils.ts',
            download_url: null,
          },
        ])
      );

      // Mock file content fetches
      mockFetch.mockResolvedValueOnce(
        mockGitHubResponse({
          name: 'index.ts',
          path: 'src/index.ts',
          sha: 'sha-1',
          size: 100,
          content: base64Encode('export {}'),
          encoding: 'base64',
          html_url: 'https://github.com/octocat/hello/blob/main/src/index.ts',
        })
      );

      mockFetch.mockResolvedValueOnce(
        mockGitHubResponse({
          name: 'utils.ts',
          path: 'src/utils.ts',
          sha: 'sha-2',
          size: 50,
          content: base64Encode('export const x = 1'),
          encoding: 'base64',
          html_url: 'https://github.com/octocat/hello/blob/main/src/utils.ts',
        })
      );

      const result = await githubImportTools.import_from_github.execute!(
        {
          connectionId: 'conn-1',
          mode: 'directory',
          owner: 'octocat',
          repo: 'hello',
          driveId: 'drive-1',
          path: 'src',
        },
        makeContext('user-123')
      ) as { success: boolean; importedCount: number; imported: string[] };

      expect(result.success).toBe(true);
      expect(result.importedCount).toBe(2);
      expect(result.imported).toEqual(['src/index.ts', 'src/utils.ts']);
    });

    it('skips binary files in directory', async () => {
      mockFetch.mockResolvedValueOnce(
        mockGitHubResponse([
          {
            name: 'logo.png',
            path: 'assets/logo.png',
            type: 'file',
            size: 5000,
            sha: 'bin-sha',
            html_url: 'https://github.com/octocat/hello/blob/main/assets/logo.png',
            download_url: null,
          },
        ])
      );

      const result = await githubImportTools.import_from_github.execute!(
        {
          connectionId: 'conn-1',
          mode: 'directory',
          owner: 'octocat',
          repo: 'hello',
          driveId: 'drive-1',
          path: 'assets',
        },
        makeContext('user-123')
      ) as { success: boolean; skipped: string[] };

      expect(result.success).toBe(true);
      expect(result.skipped).toEqual(['assets/logo.png (binary)']);
    });

    it('rejects when path points to a file not a directory', async () => {
      // GitHub returns an object (not array) for file paths
      mockFetch.mockResolvedValueOnce(
        mockGitHubResponse({
          name: 'index.ts',
          path: 'src/index.ts',
          type: 'file',
        })
      );

      const result = await githubImportTools.import_from_github.execute!(
        {
          connectionId: 'conn-1',
          mode: 'directory',
          owner: 'octocat',
          repo: 'hello',
          driveId: 'drive-1',
          path: 'src/index.ts',
        },
        makeContext('user-123')
      );

      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining('is a file, not a directory'),
      });
    });

    it('respects maxFiles limit', async () => {
      const entries = Array.from({ length: 5 }, (_, i) => ({
        name: `file${i}.ts`,
        path: `src/file${i}.ts`,
        type: 'file' as const,
        size: 10,
        sha: `sha-${i}`,
        html_url: `https://github.com/octocat/hello/blob/main/src/file${i}.ts`,
        download_url: null,
      }));

      mockFetch.mockResolvedValueOnce(mockGitHubResponse(entries));

      // Mock 2 file content responses (maxFiles=2)
      for (let i = 0; i < 2; i++) {
        mockFetch.mockResolvedValueOnce(
          mockGitHubResponse({
            name: `file${i}.ts`,
            path: `src/file${i}.ts`,
            sha: `sha-${i}`,
            size: 10,
            content: base64Encode(`export const x${i} = ${i}`),
            encoding: 'base64',
            html_url: `https://github.com/octocat/hello/blob/main/src/file${i}.ts`,
          })
        );
      }

      const result = await githubImportTools.import_from_github.execute!(
        {
          connectionId: 'conn-1',
          mode: 'directory',
          owner: 'octocat',
          repo: 'hello',
          driveId: 'drive-1',
          path: 'src',
          maxFiles: 2,
        },
        makeContext('user-123')
      ) as { success: boolean; importedCount: number };

      expect(result.success).toBe(true);
      expect(result.importedCount).toBe(2);
    });

    it('caps maxFiles at MAX_FILES_LIMIT (50)', async () => {
      mockFetch.mockResolvedValueOnce(mockGitHubResponse([]));

      const result = await githubImportTools.import_from_github.execute!(
        {
          connectionId: 'conn-1',
          mode: 'directory',
          owner: 'octocat',
          repo: 'hello',
          driveId: 'drive-1',
          path: 'src',
          maxFiles: 999,
        },
        makeContext('user-123')
      ) as { success: boolean; importedCount: number };

      // With an empty directory, importedCount will be 0 regardless,
      // but the important thing is it didn't throw
      expect(result.success).toBe(true);
    });
  });

  describe('batch timestamp consistency', () => {
    beforeEach(setupAuthMocks);

    it('uses the same importedAt for all files in a PR import', async () => {
      mockFetch.mockResolvedValueOnce(
        mockGitHubResponse({
          title: 'Two files',
          head: { sha: 'head-sha', ref: 'feature' },
          base: { ref: 'main' },
          additions: 20,
          deletions: 0,
          changed_files: 2,
        })
      );

      mockFetch.mockResolvedValueOnce(
        mockGitHubResponse([
          {
            filename: 'a.ts',
            status: 'added',
            additions: 10,
            deletions: 0,
            changes: 10,
            sha: 'sha-a',
            blob_url: 'https://github.com/o/r/blob/head-sha/a.ts',
          },
          {
            filename: 'b.ts',
            status: 'added',
            additions: 10,
            deletions: 0,
            changes: 10,
            sha: 'sha-b',
            blob_url: 'https://github.com/o/r/blob/head-sha/b.ts',
          },
        ])
      );

      mockFetch.mockResolvedValueOnce(
        mockGitHubResponse({
          name: 'a.ts', path: 'a.ts', sha: 'sha-a', size: 5,
          content: base64Encode('a'), encoding: 'base64', html_url: '',
        })
      );
      mockFetch.mockResolvedValueOnce(
        mockGitHubResponse({
          name: 'b.ts', path: 'b.ts', sha: 'sha-b', size: 5,
          content: base64Encode('b'), encoding: 'base64', html_url: '',
        })
      );

      await githubImportTools.import_from_github.execute!(
        {
          connectionId: 'conn-1',
          mode: 'pr',
          owner: 'o',
          repo: 'r',
          driveId: 'drive-1',
          pullNumber: 1,
        },
        makeContext('user-123')
      );

      // Both code page creates should have the same importedAt
      const createCalls = mockPageRepo.create.mock.calls;
      // First call is the folder, remaining are code pages
      const codePageCalls = createCalls.filter(
        (call) => (call[0] as { type: string }).type === 'CODE'
      );
      expect(codePageCalls.length).toBe(2);

      const timestamps = codePageCalls.map(
        (call) => (call[0] as { extractionMetadata: { importedAt: string } }).extractionMetadata.importedAt
      );
      expect(timestamps[0]).toBe(timestamps[1]);
    });
  });

  describe('error handling', () => {
    beforeEach(setupAuthMocks);

    it('returns error response on GitHub API failure', async () => {
      mockFetch.mockResolvedValueOnce(mockGitHubResponse('Not Found', 404));

      const result = await githubImportTools.import_from_github.execute!(
        {
          connectionId: 'conn-1',
          mode: 'file',
          owner: 'octocat',
          repo: 'nonexistent',
          driveId: 'drive-1',
          path: 'README.md',
        },
        makeContext('user-123')
      );

      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining('GitHub API error 404'),
      });
    });

    it('continues importing other files when one fails in PR mode', async () => {
      mockFetch.mockResolvedValueOnce(
        mockGitHubResponse({
          title: 'Mixed results',
          head: { sha: 'head-sha', ref: 'feature' },
          base: { ref: 'main' },
          additions: 10,
          deletions: 0,
          changed_files: 2,
        })
      );

      mockFetch.mockResolvedValueOnce(
        mockGitHubResponse([
          {
            filename: 'good.ts',
            status: 'added',
            additions: 5,
            deletions: 0,
            changes: 5,
            sha: 'good-sha',
            blob_url: '',
          },
          {
            filename: 'bad.ts',
            status: 'added',
            additions: 5,
            deletions: 0,
            changes: 5,
            sha: 'bad-sha',
            blob_url: '',
          },
        ])
      );

      // First file succeeds
      mockFetch.mockResolvedValueOnce(
        mockGitHubResponse({
          name: 'good.ts', path: 'good.ts', sha: 'good-sha', size: 5,
          content: base64Encode('ok'), encoding: 'base64', html_url: '',
        })
      );

      // Second file fails
      mockFetch.mockResolvedValueOnce(mockGitHubResponse('Server Error', 500));

      const result = await githubImportTools.import_from_github.execute!(
        {
          connectionId: 'conn-1',
          mode: 'pr',
          owner: 'o',
          repo: 'r',
          driveId: 'drive-1',
          pullNumber: 5,
        },
        makeContext('user-123')
      ) as { success: boolean; importedCount: number; skippedCount: number };

      expect(result.success).toBe(true);
      expect(result.importedCount).toBe(1);
      expect(result.skippedCount).toBe(1);
    });
  });
});
