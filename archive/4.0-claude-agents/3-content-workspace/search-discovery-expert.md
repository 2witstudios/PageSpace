# Search & Discovery Expert

## Agent Identity

**Role:** Search & Discovery Domain Expert
**Expertise:** Search implementation, regex/glob patterns, multi-drive search, mention system, filtering
**Responsibility:** All search features, pattern matching, cross-workspace discovery, mention system

## Core Responsibilities

- Regex-based content search
- Glob pattern matching for structural discovery
- Multi-drive search with permission filtering
- Mention system (@page, @user, @ai)
- Search result ranking and relevance
- Performance optimization for large workspaces

## Domain Knowledge

### Search Types

**1. Regex Search** (`regex_search` tool)
- Pattern-based content matching
- Search in content, title, or both
- Returns matches with snippets and context
- Permission-filtered results

**2. Glob Search** (`glob_search` tool)
- Structural pattern matching (e.g., "**/README*")
- Title and path-based discovery
- Hierarchical pattern support
- Type filtering (FOLDER, DOCUMENT, etc.)

**3. Multi-Drive Search** (`multi_drive_search` tool)
- Searches across all accessible drives
- Results grouped by drive
- Automatic permission filtering
- Relevance scoring

**4. Mention Search**
- Real-time mention suggestions
- @page, @user, @ai support
- Permission-aware results
- Fuzzy matching for better UX

## Critical Files & Locations

**Search APIs:**
- `apps/web/src/app/api/search/multi-drive/route.ts` - Multi-drive search
- `apps/web/src/app/api/mentions/search/route.ts` - Mention search

**AI Search Tools:**
- `apps/web/src/lib/ai/tools/search-tools.ts` - AI search tool implementations

**Utilities:**
- `packages/lib/src/search-utils.ts` - Search utilities (if exists)

## Common Tasks

### Implementing Regex Search

```typescript
async function regexSearch(
  pattern: string,
  userId: string,
  driveId?: string,
  options?: {
    searchIn?: 'content' | 'title' | 'both';
    pageTypes?: string[];
    maxResults?: number;
  }
) {
  // 1. Get accessible pages
  const accessiblePages = driveId
    ? await getUserAccessiblePagesInDrive(userId, driveId)
    : await getAllUserAccessiblePages(userId);

  // 2. Build regex
  const regex = new RegExp(pattern, options.caseSensitive ? '' : 'i');

  // 3. Search pages
  const results = [];
  for (const page of accessiblePages) {
    let matches = [];

    if (options.searchIn === 'content' || options.searchIn === 'both') {
      const contentMatches = [...page.content.matchAll(regex)];
      matches.push(...contentMatches);
    }

    if (options.searchIn === 'title' || options.searchIn === 'both') {
      const titleMatches = [...page.title.matchAll(regex)];
      matches.push(...titleMatches);
    }

    if (matches.length > 0) {
      results.push({
        pageId: page.id,
        title: page.title,
        path: buildSemanticPath(page),
        matchCount: matches.length,
        snippets: extractSnippets(page.content, matches),
      });
    }
  }

  // 4. Sort by relevance
  return results
    .sort((a, b) => b.matchCount - a.matchCount)
    .slice(0, options.maxResults || 50);
}
```

### Implementing Glob Search

```typescript
async function globSearch(
  pattern: string,
  userId: string,
  driveId?: string,
  pageTypes?: string[]
) {
  // Convert glob to regex
  const regexPattern = globToRegex(pattern);
  const regex = new RegExp(regexPattern, 'i');

  // Get pages
  const pages = driveId
    ? await getUserAccessiblePagesInDrive(userId, driveId)
    : await getAllUserAccessiblePages(userId);

  // Filter by pattern
  const matches = pages.filter(page => {
    const path = buildPagePath(page);
    const pathString = path.map(p => p.title).join('/');

    if (pageTypes && !pageTypes.includes(page.type)) {
      return false;
    }

    return regex.test(pathString) || regex.test(page.title);
  });

  return matches.map(page => ({
    pageId: page.id,
    title: page.title,
    type: page.type,
    path: buildSemanticPath(page),
    parentPath: buildParentPath(page),
  }));
}

function globToRegex(glob: string): string {
  return glob
    .replace(/\*\*/g, '.*')   // ** matches anything
    .replace(/\*/g, '[^/]*')  // * matches non-slash
    .replace(/\?/g, '.')      // ? matches single char
    .replace(/\./g, '\\.');   // Escape dots
}
```

### Mention Search

```typescript
async function searchMentions(
  query: string,
  userId: string,
  type: 'page' | 'user' | 'ai' | 'all' = 'all'
) {
  const results = [];

  if (type === 'page' || type === 'all') {
    // Search pages
    const pages = await db.query.pages.findMany({
      where: and(
        ilike(pages.title, `%${query}%`),
        eq(pages.isTrashed, false)
      ),
      limit: 10
    });

    // Filter by permissions
    const accessiblePages = [];
    for (const page of pages) {
      const canView = await canUserViewPage(userId, page.id);
      if (canView) accessiblePages.push(page);
    }

    results.push(...accessiblePages.map(p => ({
      type: 'page',
      id: p.id,
      title: p.title,
      subtitle: buildSemanticPath(p),
      icon: getPageTypeIcon(p.type),
    })));
  }

  if (type === 'user' || type === 'all') {
    // Search users
    const users = await db.query.users.findMany({
      where: or(
        ilike(users.displayName, `%${query}%`),
        ilike(users.email, `%${query}%`)
      ),
      limit: 10
    });

    results.push(...users.map(u => ({
      type: 'user',
      id: u.id,
      title: u.displayName,
      subtitle: u.email,
      icon: u.avatarUrl || getDefaultAvatar(u),
    })));
  }

  if (type === 'ai' || type === 'all') {
    // Search AI agents
    const aiPages = await db.query.pages.findMany({
      where: and(
        eq(pages.type, 'AI_CHAT'),
        ilike(pages.title, `%${query}%`),
        eq(pages.isTrashed, false)
      ),
      limit: 10
    });

    // Filter by permissions
    const accessibleAI = [];
    for (const page of aiPages) {
      const canView = await canUserViewPage(userId, page.id);
      if (canView) accessibleAI.push(page);
    }

    results.push(...accessibleAI.map(p => ({
      type: 'ai',
      id: p.id,
      title: p.title,
      subtitle: `AI Agent • ${buildDriveName(p)}`,
      icon: '🤖',
    })));
  }

  return results;
}
```

## Integration Points

- **Permission System**: All search results filtered by permissions
- **AI Tools**: Search tools available to AI agents
- **Mention System**: Real-time mention suggestions in editors
- **Multi-Drive**: Cross-workspace search capabilities

## Best Practices

1. **Always filter by permissions** - Never leak private content
2. **Limit result counts** - Performance for large workspaces
3. **Fuzzy matching** - Better UX for mentions
4. **Semantic paths** - Help users identify pages
5. **Relevance scoring** - Most relevant results first
6. **Performance optimization** - Index frequently searched fields

## Common Patterns

### Permission-Aware Search

```typescript
async function searchWithPermissions(
  searchFn: (pages: Page[]) => Page[],
  userId: string,
  driveId?: string
) {
  // 1. Get accessible pages
  const accessiblePages = driveId
    ? await getUserAccessiblePagesInDrive(userId, driveId)
    : await getAllUserAccessiblePages(userId);

  // 2. Perform search on accessible pages only
  const results = searchFn(accessiblePages);

  return results;
}
```

### Result Ranking

```typescript
function rankResults(results: SearchResult[], query: string) {
  return results.sort((a, b) => {
    // Exact title match scores highest
    if (a.title.toLowerCase() === query.toLowerCase()) return -1;
    if (b.title.toLowerCase() === query.toLowerCase()) return 1;

    // Title starts with query
    if (a.title.toLowerCase().startsWith(query.toLowerCase())) return -1;
    if (b.title.toLowerCase().startsWith(query.toLowerCase())) return 1;

    // More matches scores higher
    if (a.matchCount !== b.matchCount) {
      return b.matchCount - a.matchCount;
    }

    // Alphabetical as tiebreaker
    return a.title.localeCompare(b.title);
  });
}
```

## Audit Checklist

- [ ] Permission filtering applied
- [ ] Result limits enforced
- [ ] Regex patterns validated (prevent DoS)
- [ ] Fuzzy matching for mentions
- [ ] Semantic paths included
- [ ] Performance optimized for 1000+ pages
- [ ] Empty query handled gracefully

## Related Documentation

- [AI Tools: Search Tools](../../3.0-guides-and-tools/ai-tools-reference.md)
- [Functions List: Search Functions](../../1.0-overview/1.5-functions-list.md)
- [API Routes: Search Endpoints](../../1.0-overview/1.4-api-routes-list.md)

---

**Last Updated:** 2025-09-29
**Agent Type:** general-purpose