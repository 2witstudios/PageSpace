# PageSpace Web Search Integration

## Overview

PageSpace AI now includes web search capability powered by GLM's Web Search API. This allows the AI to search the web for current information, news, documentation, and real-time data.

## Architecture Decision

We implemented web search as a **native AI SDK tool** rather than using MCP integration for the following reasons:

1. **Architectural Consistency**: Follows PageSpace's existing tool-based architecture
2. **Simplicity**: Direct HTTP calls to GLM API without MCP protocol overhead
3. **Performance**: No additional connection management or MCP client lifecycle
4. **Control**: Better error handling, rate limiting, and response processing
5. **Server Load**: Avoids managing persistent MCP connections on the VPS

## Implementation

### Files Modified

1. **`apps/web/src/lib/ai/tools/web-search-tools.ts`** (NEW)
   - Implements the `web_search` tool
   - Makes HTTP requests to GLM Web Search API
   - Handles API key retrieval (default or user-specific)
   - Formats results for AI consumption

2. **`apps/web/src/lib/ai/ai-tools.ts`**
   - Added `webSearchTools` to exports
   - Merged with existing PageSpace tools

3. **`apps/web/src/lib/ai/tool-permissions.ts`**
   - Added `web_search` to `TOOL_METADATA`
   - Classified as `ToolOperation.READ` (read-only external data)
   - Available to all agent roles (PARTNER, PLANNER, WRITER)

4. **`apps/web/src/lib/ai/tool-instructions.ts`**
   - Updated search strategies section
   - Added web search as priority #1 in search hierarchy
   - Included usage examples and best practices

## API Key Configuration

The web search tool requires a GLM API key. It follows PageSpace's standard provider configuration pattern:

### Priority Order:
1. **Default PageSpace Settings** (`GLM_DEFAULT_API_KEY` environment variable)
2. **User's Personal GLM Settings** (encrypted in database)

### Configuration Methods:

#### Option 1: Default PageSpace Key (Recommended for Production)
```bash
# Add to .env
GLM_DEFAULT_API_KEY=your_glm_api_key_here
```

This provides web search for all users using the PageSpace Standard/Pro plans.

#### Option 2: User-Specific Keys
Users can configure their own GLM API key in Settings > AI, which will be used instead of the default.

## Usage

### Tool Parameters

```typescript
web_search({
  query: string,           // Search query - be specific and use natural language
  count?: number,          // Number of results (1-50, default 10)
  domainFilter?: string,   // Limit to specific domain (e.g., "docs.python.org")
  recencyFilter?: enum,    // Time filter: "day", "week", "month", "year", "noLimit" (default)
})
```

### Example Calls

```typescript
// General web search
web_search({
  query: "latest developments in AI safety 2025",
  count: 10,
  recencyFilter: "month"
})

// Domain-specific search
web_search({
  query: "React Server Components documentation",
  domainFilter: "react.dev",
  count: 5
})

// Recent news
web_search({
  query: "climate change policy 2025",
  count: 15,
  recencyFilter: "week"
})
```

### Response Format

```typescript
{
  success: true,
  query: "search query",
  resultsCount: 10,
  results: [
    {
      position: 1,
      title: "Article Title",
      url: "https://example.com/article",
      summary: "Article summary...",
      source: "Example.com",
      publishDate: "2025-01-15",
      reference: "ref_1"
    },
    // ... more results
  ],
  metadata: {
    searchEngine: "search-prime",
    recencyFilter: "month",
    domainFilter: "all domains",
    requestId: "...",
    timestamp: "2025-01-15T10:30:00Z"
  },
  nextSteps: [
    "Analyze the search results and synthesize key information",
    "Cite sources using the reference numbers (e.g., [ref_1])",
    // ... more suggestions
  ]
}
```

## AI Behavior

### When to Use Web Search

The AI will automatically use web search when:
- User asks about current events, news, or recent developments
- Information needed is time-sensitive or outside the AI's knowledge cutoff
- User requests up-to-date documentation or resources
- Verifying facts or finding authoritative sources

### Search Strategy Hierarchy

1. **Web Search** - For external, current information
2. **Glob Search** - For PageSpace page structure
3. **Regex Search** - For specific content patterns in PageSpace
4. **Search Pages** - For natural language queries in PageSpace
5. **Multi-Drive Search** - For cross-workspace searches in PageSpace

### Citation Format

The AI will cite web search results using reference numbers:

```
According to recent reports [ref_1], climate policies have evolved significantly.
The React team recommends [ref_2] using Server Components for data fetching.
```

## Tool Permissions

The `web_search` tool is classified as a **READ operation** and is available to all agent roles:

- ✅ **PARTNER** - Full access
- ✅ **PLANNER** - Full access (read-only nature fits planning role)
- ✅ **WRITER** - Full access

## Error Handling

The tool handles errors gracefully and returns structured error information:

```typescript
{
  success: false,
  error: "GLM API key not configured...",
  query: "search query",
  resultsCount: 0,
  results: [],
  summary: "Web search failed: ...",
  nextSteps: [
    "Check if GLM API key is configured in PageSpace settings",
    "Try a different search query",
    "If the error persists, inform the user..."
  ]
}
```

## Testing

### Manual Testing

1. **Ensure GLM API Key is Configured**:
   ```bash
   # Add to apps/web/.env
   GLM_DEFAULT_API_KEY=your_api_key_here
   ```

2. **Start the Development Server**:
   ```bash
   pnpm dev
   ```

3. **Test in AI Chat**:
   - Create or open an AI chat page
   - Ask: "What are the latest developments in AI safety?"
   - The AI should use the `web_search` tool and return current information with citations

### Expected Behavior

- The AI should recognize when web search is needed
- Search results should be formatted with titles, URLs, and summaries
- The AI should synthesize findings and cite sources using reference numbers
- Error messages should be clear and actionable

## Production Deployment

### Environment Variables

```bash
# Required for web search functionality
GLM_DEFAULT_API_KEY=your_production_glm_api_key
```

### Monitoring

Monitor the following:
- API key validity and quota
- Search request success rate
- Response times
- Error patterns

### Rate Limiting

The GLM Web Search API has rate limits. Consider:
- Implementing request caching for repeated queries
- Adding retry logic with exponential backoff
- Monitoring usage patterns

## Future Enhancements

### Potential Improvements

1. **Caching Layer**
   - Cache search results for common queries
   - Implement TTL-based cache invalidation
   - Reduce API calls and improve response times

2. **Advanced Filtering**
   - Support for multiple domain filters
   - Language-specific searches
   - Region-specific results

3. **Result Processing**
   - Automatic summarization of search results
   - Relevance scoring and ranking
   - Duplicate detection and filtering

4. **Usage Analytics**
   - Track popular search queries
   - Monitor tool effectiveness
   - Identify user search patterns

### MCP Alternative (Optional)

If desired, the GLM MCP endpoint can be integrated as an alternative:

```typescript
// Using AI SDK's MCP client (not implemented in this version)
const mcpClient = await experimental_createMCPClient({
  transport: {
    type: 'sse',
    url: 'https://api.z.ai/api/mcp/web_search/sse',
    headers: { Authorization: `Bearer ${glmApiKey}` },
  },
});

const mcpTools = await mcpClient.tools();
```

However, the native tool implementation is recommended for simplicity and performance.

## Troubleshooting

### Common Issues

#### "GLM API key not configured"
- **Solution**: Add `GLM_DEFAULT_API_KEY` to environment variables or configure in Settings > AI

#### "Web search failed: 401 Unauthorized"
- **Cause**: Invalid or expired API key
- **Solution**: Verify API key is correct and has not expired

#### "Web search failed: 429 Too Many Requests"
- **Cause**: Rate limit exceeded
- **Solution**: Implement request throttling or upgrade GLM plan

#### No results returned
- **Cause**: Query too specific or no matches
- **Solution**: Broaden search query or adjust filters

## References

- [GLM Web Search API Documentation](https://docs.z.ai/guides/web-search)
- [GLM Coding Plan](https://z.ai/pricing)
- [AI SDK Documentation](https://sdk.vercel.ai/docs)
- [PageSpace AI Tools Guide](/docs/3.0-guides-and-tools/ai-tools-guide.md)

## Support

For issues or questions:
- Check logs in `loggers.ai` for detailed error messages
- Review GLM API status and quotas
- Verify environment variables are correctly set
- Test with a simple query to isolate the issue
