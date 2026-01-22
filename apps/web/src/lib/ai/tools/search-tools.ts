import { tool } from 'ai';
import { z } from 'zod';
import { db, pages, drives, chatMessages, eq, and, sql, inArray, asc } from '@pagespace/db';
import { getUserDriveAccess, getUserAccessiblePagesInDriveWithDetails } from '@pagespace/lib/server';
import { type ToolExecutionContext } from '../core';

export const searchTools = {
  /**
   * Search page content and conversations using regular expressions
   */
  regex_search: tool({
    description: 'Search page content and conversation messages using regular expression patterns. Searches both documents and conversations by default. Returns matches with IDs, titles, and context for reference.',
    inputSchema: z.object({
      driveId: z.string().describe('The unique ID of the drive to search in'),
      pattern: z.string().describe('Regular expression pattern to search for (e.g., "TODO.*urgent", "\\d{4}-\\d{2}-\\d{2}", "deprecated.*API")'),
      searchIn: z.enum(['content', 'title', 'both']).default('content').describe('Where to search: content only, title only, or both'),
      maxResults: z.number().optional().default(50).describe('Maximum number of results to return'),
      contentTypes: z.array(z.enum(['documents', 'conversations'])).optional().default(['documents', 'conversations']).describe('What content to search: documents, conversations, or both'),
    }),
    execute: async ({ driveId, pattern, searchIn, maxResults = 50, contentTypes = ['documents', 'conversations'] }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      try {
        // Validate regex pattern to prevent ReDoS attacks
        const MAX_PATTERN_LENGTH = 200;
        if (pattern.length > MAX_PATTERN_LENGTH) {
          throw new Error(`Pattern too long (max ${MAX_PATTERN_LENGTH} characters)`);
        }

        // Validate pattern is a valid regex (also catches syntax errors early)
        let jsRegex: RegExp;
        try {
          jsRegex = new RegExp(pattern);
        } catch (e) {
          throw new Error(`Invalid regex pattern: ${(e as Error).message}`);
        }

        // Check drive access
        const hasDriveAccess = await getUserDriveAccess(userId, driveId);
        if (!hasDriveAccess) {
          throw new Error('You don\'t have access to this drive');
        }

        // Get drive info for semantic paths
        const [drive] = await db
          .select({ slug: drives.slug, name: drives.name })
          .from(drives)
          .where(eq(drives.id, driveId));

        // Create regex for PostgreSQL - escape backslashes but preserve regex shortcuts
        const pgPattern = pattern.replace(/\\(?![dDwWsSbBntrvfAZzGQE])/g, '\\\\');

        // Build where conditions based on searchIn parameter
        let whereConditions;
        if (searchIn === 'content') {
          whereConditions = and(
            eq(pages.driveId, driveId),
            eq(pages.isTrashed, false),
            sql`${pages.content} ~ ${pgPattern}`
          );
        } else if (searchIn === 'title') {
          whereConditions = and(
            eq(pages.driveId, driveId),
            eq(pages.isTrashed, false),
            sql`${pages.title} ~ ${pgPattern}`
          );
        } else {
          whereConditions = and(
            eq(pages.driveId, driveId),
            eq(pages.isTrashed, false),
            sql`${pages.content} ~ ${pgPattern} OR ${pages.title} ~ ${pgPattern}`
          );
        }

        // Build final query
        const query = db
          .select({
            id: pages.id,
            title: pages.title,
            type: pages.type,
            parentId: pages.parentId,
            content: pages.content,
          })
          .from(pages)
          .where(whereConditions);

        const matchingPages = await query.limit(maxResults);

        // Get all accessible pages upfront to avoid N+1 queries
        const accessiblePages = await getUserAccessiblePagesInDriveWithDetails(userId, driveId);
        const accessiblePageIds = new Set(accessiblePages.map(p => p.id));
        const pageMap = new Map(accessiblePages.map(p => [p.id, p]));

        const results: Array<{
          pageId: string;
          title: string;
          type: string;
          semanticPath: string;
          matchingLines: Array<{ lineNumber: number; content: string }>;
          totalMatches: number;
          conversationId?: string;
          suggestedLineRange?: { start: number; end: number };
        }> = [];

        // Search documents if requested
        if (contentTypes.includes('documents')) {
          for (const page of matchingPages) {
            // O(1) permission check using Set
            if (accessiblePageIds.has(page.id)) {
              // Build semantic path using in-memory page map
              const pathParts = [drive.slug || driveId];
              const parentChain: string[] = [];

              // Build parent chain using in-memory map (no DB queries)
              let currentPageId = page.parentId;
              while (currentPageId) {
                const parentPage = pageMap.get(currentPageId);
                if (parentPage) {
                  parentChain.unshift(parentPage.title);
                  currentPageId = parentPage.parentId;
                } else {
                  break;
                }
              }

              const semanticPath = `/${[...pathParts, ...parentChain, page.title].join('/')}`;

              // Extract matching lines if searching content
              const matchingLines: Array<{ lineNumber: number; content: string }> = [];
              if (searchIn !== 'title') {
                const lines = page.content.split('\n');
                // Use pre-validated jsRegex without /g flag to avoid lastIndex persistence bug
                lines.forEach((line, index) => {
                  if (jsRegex.test(line)) {
                    matchingLines.push({
                      lineNumber: index + 1,
                      content: line.substring(0, 200), // Truncate long lines
                    });
                  }
                });
              }

              results.push({
                pageId: page.id,
                title: page.title,
                type: page.type,
                semanticPath,
                matchingLines: matchingLines.slice(0, 5), // Limit to first 5 matches
                totalMatches: matchingLines.length,
              });
            }
          }
        }

        // Search conversations if requested (skip when searchIn='title' since messages don't have titles)
        if (contentTypes.includes('conversations') && searchIn !== 'title') {
          // Get all AI_CHAT pages in the drive that user has access to
          const aiChatPages = accessiblePages.filter(p => p.type === 'AI_CHAT');

          if (aiChatPages.length > 0) {
            const aiChatPageIds = aiChatPages.map(p => p.id);

            // Search conversation messages
            const conversationMatches = await db
              .select({
                id: chatMessages.id,
                pageId: chatMessages.pageId,
                conversationId: chatMessages.conversationId,
                content: chatMessages.content,
                createdAt: chatMessages.createdAt,
              })
              .from(chatMessages)
              .where(and(
                inArray(chatMessages.pageId, aiChatPageIds),
                eq(chatMessages.isActive, true),
                sql`${chatMessages.content} ~ ${pgPattern}`
              ))
              .orderBy(asc(chatMessages.createdAt))
              .limit(maxResults);

            // Group by conversation and build results
            const conversationResults = new Map<string, {
              pageId: string;
              conversationId: string;
              matches: Array<{ lineNumber: number; content: string }>;
            }>();

            // Batch fetch line numbers for all matching messages to avoid N+1 queries
            // Collect unique conversation IDs and page IDs from matches
            const matchingConversationIds = [...new Set(conversationMatches.map(m => m.conversationId))];
            const matchingPageIds = [...new Set(conversationMatches.map(m => m.pageId))];

            // Fetch all messages for matched conversations with row numbers in a single query
            // Partition by BOTH pageId and conversationId to ensure line numbers are scoped correctly
            // (conversationId could theoretically be reused across different pages)
            const allConvMessages = matchingConversationIds.length > 0
              ? await db
                  .select({
                    id: chatMessages.id,
                    pageId: chatMessages.pageId,
                    conversationId: chatMessages.conversationId,
                    lineNumber: sql<number>`ROW_NUMBER() OVER (PARTITION BY ${chatMessages.pageId}, ${chatMessages.conversationId} ORDER BY ${chatMessages.createdAt})`.as('line_number'),
                  })
                  .from(chatMessages)
                  .where(and(
                    inArray(chatMessages.pageId, matchingPageIds),
                    inArray(chatMessages.conversationId, matchingConversationIds),
                    eq(chatMessages.isActive, true)
                  ))
              : [];

            // Build lookup map: messageId -> lineNumber
            const lineNumberMap = new Map(allConvMessages.map(m => [m.id, Number(m.lineNumber)]));

            for (const msg of conversationMatches) {
              const key = `${msg.pageId}:${msg.conversationId}`;
              if (!conversationResults.has(key)) {
                conversationResults.set(key, {
                  pageId: msg.pageId,
                  conversationId: msg.conversationId,
                  matches: [],
                });
              }

              // Get the line number from pre-computed map (O(1) lookup)
              const lineNumber = lineNumberMap.get(msg.id) ?? 1;

              // Extract text content
              let textContent = '';
              try {
                const parsed = JSON.parse(msg.content);
                // Prefer originalContent, then parts, then textParts (legacy)
                if (parsed.originalContent) {
                  textContent = parsed.originalContent;
                } else if (parsed.parts && Array.isArray(parsed.parts)) {
                  textContent = parsed.parts
                    .map((p: { type?: string; text?: string } | string) =>
                      typeof p === 'string' ? p : p.text || ''
                    )
                    .filter(Boolean)
                    .join('\n');
                } else {
                  textContent = parsed.textParts?.[0] || msg.content;
                }
              } catch {
                textContent = msg.content;
              }

              conversationResults.get(key)!.matches.push({
                lineNumber,
                content: textContent.substring(0, 200),
              });
            }

            // Build final conversation results
            for (const [, conv] of conversationResults) {
              const page = pageMap.get(conv.pageId);
              if (page) {
                const pathParts = [drive.slug || driveId];
                let currentPageId = page.parentId;
                const parentChain: string[] = [];
                while (currentPageId) {
                  const parentPage = pageMap.get(currentPageId);
                  if (parentPage) {
                    parentChain.unshift(parentPage.title);
                    currentPageId = parentPage.parentId;
                  } else {
                    break;
                  }
                }
                const semanticPath = `/${[...pathParts, ...parentChain, page.title].join('/')}`;

                // Sort matches by lineNumber for deterministic results
                conv.matches.sort((a, b) => a.lineNumber - b.lineNumber);

                // Calculate suggested line range for context
                const firstMatch = conv.matches[0]?.lineNumber || 1;
                const suggestedStart = Math.max(1, firstMatch - 3);
                const suggestedEnd = firstMatch + 3;

                results.push({
                  pageId: conv.pageId,
                  title: page.title,
                  type: 'AI_CHAT',
                  semanticPath,
                  conversationId: conv.conversationId,
                  matchingLines: conv.matches.slice(0, 5),
                  totalMatches: conv.matches.length,
                  suggestedLineRange: { start: suggestedStart, end: suggestedEnd },
                });
              }
            }
          }
        }

        // Enforce maxResults on combined results (documents + conversations)
        const totalBeforeTruncation = results.length;
        const truncatedResults = results.slice(0, maxResults);
        const wasTruncated = totalBeforeTruncation > maxResults;

        return {
          success: true,
          driveSlug: drive.slug,
          pattern,
          searchIn,
          contentTypes,
          results: truncatedResults,
          totalResults: truncatedResults.length,
          ...(wasTruncated && {
            truncated: true,
            totalBeforeTruncation,
          }),
          summary: wasTruncated
            ? `Found ${truncatedResults.length} result${truncatedResults.length === 1 ? '' : 's'} matching pattern "${pattern}" (truncated from ${totalBeforeTruncation})`
            : `Found ${truncatedResults.length} result${truncatedResults.length === 1 ? '' : 's'} matching pattern "${pattern}"`,
          stats: {
            pagesScanned: matchingPages.length,
            pagesWithAccess: truncatedResults.length,
            documentTypes: [...new Set(truncatedResults.map(r => r.type))],
            searchedDocuments: contentTypes.includes('documents'),
            searchedConversations: contentTypes.includes('conversations'),
          },
          nextSteps: truncatedResults.length > 0 ? [
            'Use read_page with the pageId to examine full content',
            'Use read_conversation with conversationId for chat context',
            'Refine your regex pattern for more specific results',
          ] : [
            'Try a different pattern or search in a different location',
            'Check if the pattern syntax is correct for PostgreSQL regex',
          ]
        };
      } catch (error) {
        console.error('Error in regex search:', error);
        throw new Error(`Regex search failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }),

  /**
   * Find pages using glob-style patterns
   */
  glob_search: tool({
    description: 'Find pages using glob-style patterns for titles and paths. Useful for discovering structural patterns like "README*", "*/meeting-notes/*", or "**/*.test".',
    inputSchema: z.object({
      driveId: z.string().describe('The unique ID of the drive to search in'),
      pattern: z.string().describe('Glob pattern to match page titles/paths (e.g., "**/README*", "docs/**/*.md", "meeting-*")'),
      includeTypes: z.array(z.enum(['FOLDER', 'DOCUMENT', 'AI_CHAT', 'CHANNEL', 'CANVAS', 'SHEET'])).optional().describe('Filter by page types'),
      maxResults: z.number().optional().default(100).describe('Maximum number of results to return'),
    }),
    execute: async ({ driveId, pattern, includeTypes, maxResults = 100 }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      try {
        // Check drive access
        const hasDriveAccess = await getUserDriveAccess(userId, driveId);
        if (!hasDriveAccess) {
          throw new Error('You don\'t have access to this drive');
        }

        // Get drive info
        const [drive] = await db
          .select({ slug: drives.slug, name: drives.name })
          .from(drives)
          .where(eq(drives.id, driveId));

        // Build where conditions
        const whereConditions = includeTypes && includeTypes.length > 0
          ? and(
              eq(pages.driveId, driveId),
              eq(pages.isTrashed, false),
              inArray(pages.type, includeTypes)
            )
          : and(
              eq(pages.driveId, driveId),
              eq(pages.isTrashed, false)
            );

        // Get all pages in drive
        const query = db
          .select({
            id: pages.id,
            title: pages.title,
            type: pages.type,
            parentId: pages.parentId,
            position: pages.position,
          })
          .from(pages)
          .where(whereConditions);

        const allPages = await query;

        // Get all accessible pages upfront to avoid N+1 queries
        const accessiblePages = await getUserAccessiblePagesInDriveWithDetails(userId, driveId);
        const accessiblePageIds = new Set(accessiblePages.map(p => p.id));

        // Build page hierarchy with paths
        const pageMap = new Map();
        const results = [];

        // First pass: build page map
        for (const page of allPages) {
          pageMap.set(page.id, page);
        }

        // Convert glob pattern to regex
        const globToRegex = (glob: string): RegExp => {
          const escaped = glob
            .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape regex special chars except * and ?
            .replace(/\*/g, '.*')  // * matches any characters
            .replace(/\?/g, '.');   // ? matches single character
          return new RegExp(`^${escaped}$`, 'i');
        };

        const pathRegex = globToRegex(pattern);

        // Second pass: build paths and check pattern
        for (const page of allPages) {
          // O(1) permission check using Set
          if (!accessiblePageIds.has(page.id)) continue;

          // Build full path
          const pathParts = [];
          let currentPage = page;
          
          while (currentPage) {
            pathParts.unshift(currentPage.title);
            if (currentPage.parentId) {
              currentPage = pageMap.get(currentPage.parentId);
            } else {
              break;
            }
          }

          const fullPath = pathParts.join('/');
          const semanticPath = `/${drive.slug || driveId}/${fullPath}`;

          // Check if path matches pattern
          if (pathRegex.test(fullPath) || pathRegex.test(page.title)) {
            results.push({
              pageId: page.id,
              title: page.title,
              type: page.type,
              semanticPath,
              matchedOn: pathRegex.test(fullPath) ? 'path' : 'title',
            });

            if (results.length >= maxResults) break;
          }
        }

        // Sort results by path for better organization
        results.sort((a, b) => a.semanticPath.localeCompare(b.semanticPath));

        return {
          success: true,
          driveSlug: drive.slug,
          pattern,
          results,
          totalResults: results.length,
          summary: `Found ${results.length} page${results.length === 1 ? '' : 's'} matching pattern "${pattern}"`,
          stats: {
            totalPagesScanned: allPages.length,
            matchingPages: results.length,
            documentTypes: [...new Set(results.map(r => r.type))],
            matchTypes: {
              path: results.filter(r => r.matchedOn === 'path').length,
              title: results.filter(r => r.matchedOn === 'title').length,
            }
          },
          nextSteps: results.length > 0 ? [
            'Use read_page with the pageId to examine content',
            'Use the semantic paths to understand the structure',
            'Consider using regex_search for content-based searching',
          ] : [
            'Try a broader pattern (e.g., "**/*" for all pages)',
            'Check if your pattern syntax is correct',
            'Verify the pages exist with list_pages',
          ]
        };
      } catch (error) {
        console.error('Error in glob search:', error);
        throw new Error(`Glob search failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }),

  /**
   * Search across multiple drives simultaneously
   */
  multi_drive_search: tool({
    description: 'Search for content across multiple drives at once. Automatically filters results based on user permissions.',
    inputSchema: z.object({
      searchQuery: z.string().describe('Text to search for in page content and titles'),
      searchType: z.enum(['text', 'regex']).default('text').describe('Use text for simple search, regex for pattern matching'),
      maxResultsPerDrive: z.number().optional().default(20).describe('Maximum results to return per drive'),
    }),
    execute: async ({ searchQuery, searchType, maxResultsPerDrive = 20 }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      try {
        // Get all drives user has access to
        const userDrives = await db
          .selectDistinct({ 
            id: drives.id,
            name: drives.name,
            slug: drives.slug,
          })
          .from(drives)
          .where(eq(drives.isTrashed, false));

        const results = [];

        for (const drive of userDrives) {
          // Check drive access
          const hasDriveAccess = await getUserDriveAccess(userId, drive.id);
          if (!hasDriveAccess) continue;

          // Build search conditions
          let searchWhereConditions;
          if (searchType === 'regex') {
            const pgPattern = searchQuery.replace(/\\(?![dDwWsSbBntrvfAZzGQE])/g, '\\\\');
            searchWhereConditions = and(
              eq(pages.driveId, drive.id),
              eq(pages.isTrashed, false),
              sql`${pages.content} ~ ${pgPattern} OR ${pages.title} ~ ${pgPattern}`
            );
          } else {
            const searchPattern = `%${searchQuery}%`;
            searchWhereConditions = and(
              eq(pages.driveId, drive.id),
              eq(pages.isTrashed, false),
              sql`${pages.content} ILIKE ${searchPattern} OR ${pages.title} ILIKE ${searchPattern}`
            );
          }

          // Search in this drive
          const driveQuery = db
            .select({
              id: pages.id,
              title: pages.title,
              type: pages.type,
              content: pages.content,
            })
            .from(pages)
            .where(searchWhereConditions);

          const drivePages = await driveQuery.limit(maxResultsPerDrive);

          // Get all accessible pages upfront to avoid N+1 queries
          const accessiblePages = await getUserAccessiblePagesInDriveWithDetails(userId, drive.id);
          const accessiblePageIds = new Set(accessiblePages.map(p => p.id));

          // Filter by permissions using O(1) Set lookup
          const driveResults = [];
          for (const page of drivePages) {
            if (accessiblePageIds.has(page.id)) {
              driveResults.push({
                pageId: page.id,
                title: page.title,
                type: page.type,
                excerpt: page.content.substring(0, 150) + '...',
              });
            }
          }

          if (driveResults.length > 0) {
            results.push({
              driveId: drive.id,
              driveName: drive.name,
              driveSlug: drive.slug,
              matches: driveResults,
              count: driveResults.length,
            });
          }
        }

        return {
          success: true,
          searchQuery,
          searchType,
          results,
          totalDrives: results.length,
          totalMatches: results.reduce((sum, r) => sum + r.count, 0),
          summary: `Found ${results.reduce((sum, r) => sum + r.count, 0)} matches across ${results.length} drive${results.length === 1 ? '' : 's'}`,
          stats: {
            drivesSearched: userDrives.length,
            drivesWithResults: results.length,
            totalMatches: results.reduce((sum, r) => sum + r.count, 0),
          },
          nextSteps: results.length > 0 ? [
            'Use read_page with specific pageIds to examine content',
            'Focus on a specific drive for more detailed search',
            'Use regex_search or glob_search for more precise patterns',
          ] : [
            'Try a different search query',
            'Check if you have access to the expected drives',
            'Use list_drives to see available workspaces',
          ]
        };
      } catch (error) {
        console.error('Error in multi-drive search:', error);
        throw new Error(`Multi-drive search failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }),
};