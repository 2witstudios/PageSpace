import { tool } from 'ai';
import { z } from 'zod';
import {
  canUserEditPage,
  loggers,
  logPageActivity,
  getActorInfo,
  detectPageContentFormat,
  hashWithPrefix,
  computePageStateHash,
  createPageVersion,
  pageRepository,
  driveRepository,
} from '@pagespace/lib/server';
import { createChangeGroupId } from '@pagespace/lib/monitoring';
import {
  getConnectionWithProvider,
  decryptCredentials,
} from '@pagespace/lib/integrations';
import { db } from '@pagespace/db';
import { detectLanguageFromFilename, isBinaryFile } from '@pagespace/lib/utils/language-detection';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';
import { type ToolExecutionContext } from '../core';

const importLogger = loggers.ai.child({ module: 'github-import-tools' });

const GITHUB_API_BASE = 'https://api.github.com';
const MAX_FILES_LIMIT = 50;
const DEFAULT_MAX_FILES = 25;
const MAX_DIRECTORY_DEPTH = 3;

interface GitHubFileEntry {
  name: string;
  path: string;
  type: 'file' | 'dir' | 'symlink' | 'submodule';
  size: number;
  sha: string;
  html_url: string;
  download_url: string | null;
}

interface GitHubFileContent {
  name: string;
  path: string;
  sha: string;
  size: number;
  content: string;
  encoding: string;
  html_url: string;
}

interface GitHubPRFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  sha: string;
  blob_url: string;
  patch?: string;
}

async function githubFetch(
  path: string,
  token: string,
  queryParams?: Record<string, string>
): Promise<unknown> {
  const url = new URL(`${GITHUB_API_BASE}${path}`);
  if (queryParams) {
    for (const [key, value] of Object.entries(queryParams)) {
      url.searchParams.set(key, value);
    }
  }

  const response = await fetch(url.toString(), {
    headers: {
      'Accept': 'application/vnd.github.v3+json',
      'Authorization': `token ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(
      `GitHub API error ${response.status}: ${response.statusText}${errorBody ? ` - ${errorBody.slice(0, 200)}` : ''}`
    );
  }

  return response.json();
}

async function resolveGitHubToken(connectionId: string): Promise<string> {
  const connection = await getConnectionWithProvider(db, connectionId);
  if (!connection) {
    throw new Error(
      'GitHub connection not found. Connect your GitHub account in Settings > Integrations.'
    );
  }
  if (connection.status !== 'active') {
    throw new Error(
      `GitHub connection is ${connection.status}. Please reconnect in Settings > Integrations.`
    );
  }

  const credentials = (await decryptCredentials(
    connection.credentials as Record<string, unknown>
  )) as { accessToken?: string; token?: string };

  const token = credentials.accessToken || credentials.token;
  if (!token) {
    throw new Error('GitHub access token not found in connection credentials.');
  }

  return token;
}

async function createCodePage(params: {
  title: string;
  content: string;
  driveId: string;
  parentId: string | null;
  userId: string;
  extractionMetadata: Record<string, unknown>;
  contentHash: string;
}): Promise<{ id: string; title: string }> {
  const nextPosition = await pageRepository.getNextPosition(
    params.driveId,
    params.parentId
  );

  const contentFormat = detectPageContentFormat(params.content);
  const contentRef = hashWithPrefix(contentFormat, params.content);
  const stateHash = computePageStateHash({
    title: params.title,
    contentRef,
    parentId: params.parentId,
    position: nextPosition,
    isTrashed: false,
    type: 'CODE',
    driveId: params.driveId,
  });
  const changeGroupId = createChangeGroupId();

  const newPage = await pageRepository.create({
    title: params.title,
    type: 'CODE',
    content: params.content,
    contentMode: 'markdown',
    driveId: params.driveId,
    parentId: params.parentId,
    position: nextPosition,
    isTrashed: false,
    revision: 0,
    stateHash,
    extractionMethod: 'github-import',
    extractionMetadata: params.extractionMetadata,
    contentHash: params.contentHash,
  });

  await createPageVersion({
    pageId: newPage.id,
    driveId: params.driveId,
    createdBy: params.userId,
    source: 'system',
    content: params.content,
    contentFormat,
    pageRevision: 0,
    stateHash,
    changeGroupId,
    changeGroupType: 'ai',
    metadata: { source: 'github-import' },
  });

  await broadcastPageEvent(
    createPageEventPayload(params.driveId, newPage.id, 'created', {
      parentId: params.parentId,
      title: newPage.title,
      type: 'CODE',
    })
  );

  // Fire-and-forget activity logging
  getActorInfo(params.userId).then(actorInfo => {
    logPageActivity(params.userId, 'create', {
      id: newPage.id,
      title: newPage.title,
      driveId: params.driveId,
    }, {
      ...actorInfo,
      isAiGenerated: true,
      metadata: { source: 'github-import', ...params.extractionMetadata },
    });
  }).catch(() => {});

  return { id: newPage.id, title: newPage.title };
}

async function createFolderPage(params: {
  title: string;
  driveId: string;
  parentId: string | null;
  userId: string;
  extractionMetadata?: Record<string, unknown>;
}): Promise<{ id: string; title: string }> {
  const nextPosition = await pageRepository.getNextPosition(
    params.driveId,
    params.parentId
  );

  const contentRef = hashWithPrefix('text', '');
  const stateHash = computePageStateHash({
    title: params.title,
    contentRef,
    parentId: params.parentId,
    position: nextPosition,
    isTrashed: false,
    type: 'FOLDER',
    driveId: params.driveId,
  });
  const changeGroupId = createChangeGroupId();

  const newPage = await pageRepository.create({
    title: params.title,
    type: 'FOLDER',
    content: '',
    driveId: params.driveId,
    parentId: params.parentId,
    position: nextPosition,
    isTrashed: false,
    revision: 0,
    stateHash,
    ...(params.extractionMetadata && {
      extractionMethod: 'github-import',
      extractionMetadata: params.extractionMetadata,
    }),
  });

  await createPageVersion({
    pageId: newPage.id,
    driveId: params.driveId,
    createdBy: params.userId,
    source: 'system',
    content: '',
    contentFormat: 'text',
    pageRevision: 0,
    stateHash,
    changeGroupId,
    changeGroupType: 'ai',
    metadata: { source: 'github-import' },
  });

  await broadcastPageEvent(
    createPageEventPayload(params.driveId, newPage.id, 'created', {
      parentId: params.parentId,
      title: newPage.title,
      type: 'FOLDER',
    })
  );

  // Fire-and-forget activity logging
  getActorInfo(params.userId).then(actorInfo => {
    logPageActivity(params.userId, 'create', {
      id: newPage.id,
      title: newPage.title,
      driveId: params.driveId,
    }, {
      ...actorInfo,
      isAiGenerated: true,
      metadata: { source: 'github-import' },
    });
  }).catch(() => {});

  return { id: newPage.id, title: newPage.title };
}

function decodeBase64Content(content: string): string {
  return Buffer.from(content.replace(/\n/g, ''), 'base64').toString('utf-8');
}

async function importSingleFile(params: {
  owner: string;
  repo: string;
  path: string;
  ref?: string;
  token: string;
  driveId: string;
  parentId: string | null;
  userId: string;
}): Promise<{ id: string; title: string; language: string }> {
  const queryParams: Record<string, string> = {};
  if (params.ref) queryParams.ref = params.ref;

  const data = (await githubFetch(
    `/repos/${params.owner}/${params.repo}/contents/${params.path}`,
    params.token,
    queryParams
  )) as GitHubFileContent;

  if (!data.content || data.encoding !== 'base64') {
    throw new Error(`File at ${params.path} has no readable content or unsupported encoding.`);
  }

  const content = decodeBase64Content(data.content);
  const language = detectLanguageFromFilename(data.name);

  const page = await createCodePage({
    title: data.name,
    content,
    driveId: params.driveId,
    parentId: params.parentId,
    userId: params.userId,
    contentHash: data.sha,
    extractionMetadata: {
      source: 'github',
      owner: params.owner,
      repo: params.repo,
      path: data.path,
      ref: params.ref ?? null,
      sha: data.sha,
      htmlUrl: data.html_url,
      importedAt: new Date().toISOString(),
      language,
    },
  });

  return { id: page.id, title: page.title, language };
}

export const githubImportTools = {
  import_from_github: tool({
    description:
      'Import code from a GitHub repository into PageSpace as CODE pages. Supports three modes: "file" imports a single file, "pr" imports all changed files from a pull request into a folder, "directory" imports a directory of files. Requires a GitHub integration connection.',
    inputSchema: z.object({
      connectionId: z
        .string()
        .describe('ID of the GitHub integration connection to use'),
      mode: z
        .enum(['file', 'pr', 'directory'])
        .describe('Import mode: "file" for a single file, "pr" for PR changed files, "directory" for a directory'),
      owner: z.string().describe('Repository owner (e.g. "octocat")'),
      repo: z.string().describe('Repository name (e.g. "hello-world")'),
      driveId: z.string().describe('Target drive ID for created pages'),
      parentId: z
        .string()
        .optional()
        .describe('Parent page ID (creates at drive root if omitted)'),
      path: z
        .string()
        .optional()
        .describe('File or directory path (required for "file" and "directory" modes)'),
      ref: z
        .string()
        .optional()
        .describe('Branch, tag, or commit SHA (defaults to default branch)'),
      pullNumber: z
        .number()
        .optional()
        .describe('Pull request number (required for "pr" mode)'),
      recursive: z
        .boolean()
        .optional()
        .describe('Recursively import subdirectories (for "directory" mode, max depth 3)'),
      maxFiles: z
        .number()
        .optional()
        .describe(`Maximum files to import (default ${DEFAULT_MAX_FILES}, max ${MAX_FILES_LIMIT})`),
    }),
    execute: async (params, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      const {
        connectionId,
        mode,
        owner,
        repo,
        driveId,
        parentId,
        path,
        ref,
        pullNumber,
        recursive,
        maxFiles: rawMaxFiles,
      } = params;

      const maxFiles = Math.min(rawMaxFiles ?? DEFAULT_MAX_FILES, MAX_FILES_LIMIT);

      // Verify drive exists
      const drive = await driveRepository.findByIdBasic(driveId);
      if (!drive) {
        throw new Error(`Drive "${driveId}" not found`);
      }

      // Verify permissions
      if (parentId) {
        const parentExists = await pageRepository.existsInDrive(parentId, driveId);
        if (!parentExists) {
          throw new Error(`Parent page "${parentId}" not found in this drive`);
        }
        const canEdit = await canUserEditPage(userId, parentId);
        if (!canEdit) {
          throw new Error('Insufficient permissions to create pages in this location');
        }
      } else if (drive.ownerId !== userId) {
        throw new Error('Only drive owners can create pages at the root level');
      }

      // Resolve GitHub credentials
      const token = await resolveGitHubToken(connectionId);

      try {
        switch (mode) {
          case 'file': {
            if (!path) {
              throw new Error('path is required for file import mode');
            }

            if (isBinaryFile(path)) {
              return {
                success: false,
                error: `${path} appears to be a binary file and cannot be imported as code.`,
              };
            }

            const result = await importSingleFile({
              owner,
              repo,
              path,
              ref,
              token,
              driveId,
              parentId: parentId ?? null,
              userId,
            });

            return {
              success: true,
              pageId: result.id,
              title: result.title,
              language: result.language,
              source: `${owner}/${repo}/${path}${ref ? `@${ref}` : ''}`,
            };
          }

          case 'pr': {
            if (!pullNumber) {
              throw new Error('pullNumber is required for PR import mode');
            }

            // Get PR metadata
            const pr = (await githubFetch(
              `/repos/${owner}/${repo}/pulls/${pullNumber}`,
              token
            )) as {
              title: string;
              head: { sha: string; ref: string };
              base: { ref: string };
              additions: number;
              deletions: number;
              changed_files: number;
            };

            // Get changed files
            const files = (await githubFetch(
              `/repos/${owner}/${repo}/pulls/${pullNumber}/files`,
              token,
              { per_page: String(Math.min(maxFiles, 100)) }
            )) as GitHubPRFile[];

            // Create folder for PR
            const folder = await createFolderPage({
              title: `PR #${pullNumber}: ${pr.title}`,
              driveId,
              parentId: parentId ?? null,
              userId,
              extractionMetadata: {
                source: 'github',
                owner,
                repo,
                pullNumber,
                prTitle: pr.title,
                headSha: pr.head.sha,
                headRef: pr.head.ref,
                baseRef: pr.base.ref,
                additions: pr.additions,
                deletions: pr.deletions,
                changedFiles: pr.changed_files,
                importedAt: new Date().toISOString(),
              },
            });

            const imported: Array<{ title: string; status: string }> = [];
            const skipped: string[] = [];

            for (const file of files.slice(0, maxFiles)) {
              if (isBinaryFile(file.filename)) {
                skipped.push(`${file.filename} (binary)`);
                continue;
              }

              if (file.status === 'removed') {
                skipped.push(`${file.filename} (deleted)`);
                continue;
              }

              try {
                // Fetch file content at the PR head
                const fileData = (await githubFetch(
                  `/repos/${owner}/${repo}/contents/${file.filename}`,
                  token,
                  { ref: pr.head.sha }
                )) as GitHubFileContent;

                if (!fileData.content || fileData.encoding !== 'base64') {
                  skipped.push(`${file.filename} (no content)`);
                  continue;
                }

                const content = decodeBase64Content(fileData.content);
                const language = detectLanguageFromFilename(file.filename);

                await createCodePage({
                  title: file.filename.split('/').pop() || file.filename,
                  content,
                  driveId,
                  parentId: folder.id,
                  userId,
                  contentHash: file.sha,
                  extractionMetadata: {
                    source: 'github',
                    owner,
                    repo,
                    path: file.filename,
                    ref: pr.head.sha,
                    sha: file.sha,
                    htmlUrl: file.blob_url,
                    pullNumber,
                    fileStatus: file.status,
                    additions: file.additions,
                    deletions: file.deletions,
                    importedAt: new Date().toISOString(),
                    language,
                  },
                });

                imported.push({ title: file.filename, status: file.status });
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                skipped.push(`${file.filename} (${msg.slice(0, 80)})`);
                importLogger.warn({ file: file.filename, error: msg }, 'Failed to import PR file');
              }
            }

            return {
              success: true,
              folderId: folder.id,
              folderTitle: folder.title,
              importedCount: imported.length,
              imported,
              skippedCount: skipped.length,
              skipped,
              totalPRFiles: pr.changed_files,
              source: `${owner}/${repo}#${pullNumber}`,
            };
          }

          case 'directory': {
            if (path === undefined) {
              throw new Error('path is required for directory import mode (use "" for repo root)');
            }

            const dirPath = path || '';
            const queryParams: Record<string, string> = {};
            if (ref) queryParams.ref = ref;

            const entries = (await githubFetch(
              `/repos/${owner}/${repo}/contents/${dirPath}`,
              token,
              queryParams
            )) as GitHubFileEntry[];

            if (!Array.isArray(entries)) {
              throw new Error(
                `Path "${dirPath}" is a file, not a directory. Use mode "file" instead.`
              );
            }

            const dirName =
              dirPath.split('/').pop() || `${owner}/${repo}`;

            const folder = await createFolderPage({
              title: dirName,
              driveId,
              parentId: parentId ?? null,
              userId,
              extractionMetadata: {
                source: 'github',
                owner,
                repo,
                path: dirPath,
                ref: ref ?? null,
                importedAt: new Date().toISOString(),
              },
            });

            const imported: string[] = [];
            const skipped: string[] = [];
            let filesProcessed = 0;

            const processDirectory = async (
              dirEntries: GitHubFileEntry[],
              targetParentId: string,
              depth: number
            ) => {
              for (const entry of dirEntries) {
                if (filesProcessed >= maxFiles) break;

                if (entry.type === 'file') {
                  if (isBinaryFile(entry.name)) {
                    skipped.push(`${entry.path} (binary)`);
                    continue;
                  }

                  try {
                    const qp: Record<string, string> = {};
                    if (ref) qp.ref = ref;

                    const fileData = (await githubFetch(
                      `/repos/${owner}/${repo}/contents/${entry.path}`,
                      token,
                      qp
                    )) as GitHubFileContent;

                    if (!fileData.content || fileData.encoding !== 'base64') {
                      skipped.push(`${entry.path} (no content)`);
                      continue;
                    }

                    const content = decodeBase64Content(fileData.content);

                    await createCodePage({
                      title: entry.name,
                      content,
                      driveId,
                      parentId: targetParentId,
                      userId,
                      contentHash: entry.sha,
                      extractionMetadata: {
                        source: 'github',
                        owner,
                        repo,
                        path: entry.path,
                        ref: ref ?? null,
                        sha: entry.sha,
                        htmlUrl: entry.html_url,
                        importedAt: new Date().toISOString(),
                        language: detectLanguageFromFilename(entry.name),
                      },
                    });

                    imported.push(entry.path);
                    filesProcessed++;
                  } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    skipped.push(`${entry.path} (${msg.slice(0, 80)})`);
                  }
                } else if (
                  entry.type === 'dir' &&
                  recursive &&
                  depth < MAX_DIRECTORY_DEPTH
                ) {
                  try {
                    const subFolder = await createFolderPage({
                      title: entry.name,
                      driveId,
                      parentId: targetParentId,
                      userId,
                    });

                    const qp: Record<string, string> = {};
                    if (ref) qp.ref = ref;

                    const subEntries = (await githubFetch(
                      `/repos/${owner}/${repo}/contents/${entry.path}`,
                      token,
                      qp
                    )) as GitHubFileEntry[];

                    if (Array.isArray(subEntries)) {
                      await processDirectory(subEntries, subFolder.id, depth + 1);
                    }
                  } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    skipped.push(`${entry.path}/ (${msg.slice(0, 80)})`);
                  }
                }
              }
            };

            await processDirectory(entries, folder.id, 0);

            return {
              success: true,
              folderId: folder.id,
              folderTitle: folder.title,
              importedCount: imported.length,
              imported,
              skippedCount: skipped.length,
              skipped,
              source: `${owner}/${repo}/${dirPath}${ref ? `@${ref}` : ''}`,
            };
          }

          default:
            throw new Error(`Unknown import mode: ${mode}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        importLogger.error({ mode, owner, repo, error: message }, 'GitHub import failed');
        return { success: false, error: message };
      }
    },
  }),
};
