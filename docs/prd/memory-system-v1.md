# PRD: AI Memory System v1

**Status**: Draft
**Author**: Auto-generated from design discussion
**Date**: 2026-01-16

---

## 1. Problem Statement

PageSpace AI is **token expensive**. Every request includes:
- System prompt: 1,500-3,500 tokens
- Tool definitions: 3,000-9,000 tokens
- Conversation history: 700-3,500 tokens
- Page tree context: ~2,500 tokens

**Baseline cost: 5,600-16,400 tokens before the user even speaks.**

Despite this cost, PageSpace AI has **no persistent memory**:
- Cannot remember user preferences across conversations
- Cannot remember project decisions or context
- Cannot learn from past interactions
- Every conversation starts from zero

Users must repeatedly re-explain:
- Their technical background
- Project architecture decisions
- Communication preferences
- Workspace conventions

---

## 2. Design Constraints

### 2.1 Token Efficiency is Critical

Any memory system must have **minimal token overhead**. We cannot afford:
- Verbose memory formats
- Redundant context inclusion
- Unbounded memory growth

**Budget: ~500 tokens maximum for memory context.**

### 2.2 Realtime Collaboration Constraints

PageSpace uses Socket.IO for realtime sync with:
- 1000ms debounce on content saves
- Optimistic locking via revision numbers
- No CRDT/OT (last-write-wins)

Implications for memory:
- Embeddings would become stale within seconds of edits
- Vector databases add consistency complexity
- Pre-computed context can be outdated by the time it's used

### 2.3 Existing Context Already Provides Structure

The **page tree** is already included in AI context (~2,500 tokens for 150 pages):
```
├── 📁 Projects
│   ├── 📄 Auth Implementation
│   └── 📄 API Design
└── 📄 README
```

This provides:
- Workspace structure and navigation
- Page titles (often descriptive)
- Page types and hierarchy

**Memory should complement the tree, not duplicate it.**

### 2.4 Search Tools Already Exist

PageSpace has regex and glob search tools that handle:
- Finding specific text patterns
- Locating pages by path
- Multi-drive search

**Memory should not replicate what search already does.**

---

## 3. What Memory Should Solve

The gap between "what exists" and "what AI needs":

| Need | Current Solution | Gap |
|------|------------------|-----|
| Find text pattern | regex_search tool | None |
| Navigate structure | Page tree in context | None |
| **User preferences** | None | AI forgets every conversation |
| **Project decisions** | None | "Why did we choose X?" lost |
| **Terminology** | None | AI doesn't know project vocab |
| **Working context** | None | "What am I working on?" unknown |

Memory solves the **persistent context** problem, not the search problem.

---

## 4. Prior Art Analysis

### 4.1 ChatGPT Memory (Feb 2024)

OpenAI's first implementation was deliberately simple:

```
Memory = list of short fact strings

Examples:
- "User is a software engineer"
- "User prefers concise responses"
- "User works with TypeScript"
```

**Implementation:**
- AI detects memorable information during chat
- Calls internal `save_memory(fact)` tool
- ALL memories included in EVERY conversation
- User can view and delete individual facts

**What worked:**
- Simple mental model
- Transparent (users see what's remembered)
- User control (delete unwanted memories)
- Good enough without sophistication

**What was clunky:**
- Remembered irrelevant things
- No organization or scoping
- Memories accumulated without cleanup
- Sometimes contradictory

### 4.2 ChatGPT Projects (Mid 2024)

```
Project = {
  instructions: string,    // Custom prompt
  files: File[],           // Always in context
  conversations: Chat[],   // Scoped chats
}
```

Added **scoping** - different projects have different context.

### 4.3 Claude Projects

Similar to ChatGPT Projects:
- Project-level instructions
- Knowledge files in context
- No persistent cross-conversation memory

### 4.4 Key Lesson

> Both shipped "dumb but transparent" and iterated.

A simple list of facts that users can see and delete beats a sophisticated invisible system. **Ship the simple version first.**

---

## 5. Design Decision: Fact-Based Memory

### 5.1 Why Facts, Not Prose

**Prose memory:**
```
"The user is a senior software engineer who has been working on PageSpace
for several months. They prefer functional programming patterns and have
expressed frustration with overly verbose responses. The project uses
TypeScript with Drizzle ORM, and they recently decided to avoid Redux
in favor of Zustand for state management."
```
- ~80 tokens
- Hard to update incrementally
- Difficult to delete specific parts
- AI tends to ramble

**Fact-based memory:**
```
- Senior software engineer
- Prefers functional patterns
- Prefers concise responses
- Project uses TypeScript + Drizzle
- Chose Zustand over Redux
```
- ~40 tokens (50% savings)
- Easy to add/remove individual facts
- Clear and scannable
- Matches how ChatGPT Memory works

### 5.2 Why Two Scopes: User + Drive

Following PageSpace's existing patterns:

| Entity | User-scoped | Drive-scoped |
|--------|-------------|--------------|
| Conversations | ✅ global | ✅ drive-specific |
| Activity logs | ✅ user activity | ✅ drive activity |
| Permissions | ✅ user role | ✅ drive membership |
| **Memory** | ✅ user facts | ✅ drive facts |

**User memory** (follows user everywhere):
- Communication preferences
- Technical background
- Personal working style

**Drive memory** (shared with drive members):
- Architecture decisions
- Project terminology
- Team conventions
- Current focus areas

### 5.3 Why Include All Facts (No Retrieval)

Sophisticated option: Embed facts, retrieve relevant ones per query.

Simple option: Include all facts in every request.

**We chose simple because:**
1. Fact count is bounded (target: <50 per scope)
2. Total token cost is predictable (~300-500 tokens)
3. No retrieval latency
4. No relevance matching errors
5. Users see exactly what AI sees

At 50 facts × 10 tokens average = 500 tokens. Acceptable.

---

## 6. Requirements

### 6.1 Schema

```typescript
// User-scoped memories
export const userMemories = pgTable('user_memories', {
  id: text('id').primaryKey(),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  fact: text('fact').notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  source: text('source'),  // 'ai' | 'user' - who created it
});

// Drive-scoped memories
export const driveMemories = pgTable('drive_memories', {
  id: text('id').primaryKey(),
  driveId: text('driveId').notNull().references(() => drives.id, { onDelete: 'cascade' }),
  fact: text('fact').notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  createdBy: text('createdBy').references(() => users.id, { onDelete: 'set null' }),
  source: text('source'),  // 'ai' | 'user'
});
```

### 6.2 AI Tools

```typescript
// Save a memory
save_memory({
  scope: 'user' | 'drive',
  fact: string,  // Single fact, max 200 chars
})

// Remove a memory (AI can also forget)
remove_memory({
  scope: 'user' | 'drive',
  factId: string,
})
```

**AI guidance in system prompt:**
```
You can remember important information using the save_memory tool.

Save a memory when you learn:
- User preferences (communication style, technical background)
- Project decisions (architecture choices, rejected alternatives)
- Terminology (project-specific terms and their meanings)
- Context (current focus, ongoing work)

Keep facts:
- Short (under 20 words)
- Specific (not vague)
- Actionable (helps future conversations)

Don't save:
- Trivial information
- Things already in the page tree
- Temporary context (one-off questions)
```

### 6.3 Context Assembly

```typescript
function assembleMemoryContext(
  userFacts: string[],
  driveFacts: string[] | null
): string {
  let context = '';

  if (userFacts.length > 0) {
    context += '## About This User\n\n';
    context += userFacts.map(f => `- ${f}`).join('\n');
    context += '\n\n';
  }

  if (driveFacts && driveFacts.length > 0) {
    context += '## About This Workspace\n\n';
    context += driveFacts.map(f => `- ${f}`).join('\n');
    context += '\n\n';
  }

  return context;
}
```

### 6.4 API Endpoints

```
GET    /api/memory/user           # List user's memories
POST   /api/memory/user           # Add user memory (manual)
DELETE /api/memory/user/:id       # Delete user memory

GET    /api/memory/drive/:driveId # List drive memories
POST   /api/memory/drive/:driveId # Add drive memory (manual)
DELETE /api/memory/drive/:id      # Delete drive memory
```

### 6.5 Permissions

| Action | User Memory | Drive Memory |
|--------|-------------|--------------|
| View own | ✅ Owner | ✅ All members |
| Add (AI) | ✅ During chat | ✅ During chat |
| Add (manual) | ✅ Owner | ✅ Admin/Owner |
| Delete | ✅ Owner | ✅ Admin/Owner |

### 6.6 UI Requirements

**User Memory (Settings page):**
- List of facts with timestamps
- Delete button per fact
- "Clear all" button
- Manual "Add fact" input

**Drive Memory (Drive settings, admin only):**
- List of facts with who added them
- Delete button per fact
- "Clear all" button
- Manual "Add fact" input

**Inline indicator (optional, future):**
- Small indicator when AI saves a memory
- "Remembered: [fact]" toast notification

---

## 7. Explicit Non-Goals (v1)

### 7.1 No Activity Log Integration

We considered automatically summarizing activity logs into memory context.

**Deferred because:**
- Summarization requires AI call (cost + latency)
- Relevance matching without embeddings is just search
- Activity logs are already queryable via tools
- Adds significant complexity

**Future consideration:** If users frequently ask "what did I do recently?", revisit.

### 7.2 No Embedding/Vector Search

We considered semantic memory retrieval.

**Deferred because:**
- Realtime collaboration makes embeddings stale quickly
- Adds infrastructure complexity (vector DB)
- Simple fact inclusion is good enough for <50 facts
- Token cost of including all facts is acceptable

**Future consideration:** If fact count exceeds 100+, consider retrieval.

### 7.3 No Automatic Decay

We considered automatically removing old/unused memories.

**Deferred because:**
- Defining "unused" is ambiguous
- Risk of deleting important context
- Users can manually manage
- Adds complexity

**Future consideration:** Add if memory lists become unmanageable.

### 7.4 No Duplicate Detection

We considered preventing duplicate/similar facts.

**Deferred because:**
- Similarity matching is fuzzy
- Users can manually clean up
- AI can be instructed to check before saving

**Future consideration:** Add if duplicates become a real problem.

### 7.5 No Cross-Drive Memory

Each drive's memory is isolated. No "workspace-wide" memory.

**Rationale:**
- Drives may have different teams
- Privacy/permission complexity
- User memory already provides cross-drive context

---

## 8. Success Metrics

### 8.1 Adoption
- % of active users with at least 1 saved memory (target: 30% in 30 days)
- Average memories per user (target: 5-15)
- Average memories per active drive (target: 3-10)

### 8.2 Retention Quality
- % of memories manually deleted within 7 days (target: <20%)
- User feedback on memory relevance

### 8.3 Token Efficiency
- Average memory context size (target: <500 tokens)
- Memory context as % of total context (target: <5%)

### 8.4 Qualitative
- Reduction in "let me explain again" user messages
- User feedback on AI "remembering" things

---

## 9. Implementation Phases

### Phase 1: Core Memory (This PRD)
- Schema and migrations
- AI tools (save_memory, remove_memory)
- System prompt integration
- Basic API endpoints
- Settings UI for viewing/deleting

### Phase 2: Polish (Future)
- Memory save notifications
- Duplicate detection
- Fact editing (not just delete)
- Memory export

### Phase 3: Intelligence (Future, If Needed)
- Fact limits with smart pruning
- Activity log integration
- Relevance-based retrieval
- Memory insights ("You haven't updated workspace context in 30 days")

---

## 10. Open Questions

1. **Fact character limit?** Proposed: 200 chars. Too short? Too long?

2. **Fact count limit?** Proposed: 50 per scope. Need to validate token math.

3. **AI save frequency?** Should we rate-limit how often AI can save memories?

4. **Visibility of AI saves?** Toast notification? Silent? Configurable?

5. **Migration from existing fields?**
   - `userProfiles.bio` → Seed user memories?
   - `drives.drivePrompt` → Keep separate (instructions) or merge?

---

## 11. Appendix: Token Budget Analysis

### Current State (No Memory)
| Component | Min | Max |
|-----------|-----|-----|
| System prompt | 1,500 | 3,500 |
| Tool definitions | 3,000 | 9,000 |
| Conversation history | 700 | 3,500 |
| Page tree | 1,500 | 3,000 |
| **Total baseline** | **6,700** | **19,000** |

### With Memory (v1)
| Component | Min | Max |
|-----------|-----|-----|
| Baseline | 6,700 | 19,000 |
| User memory (20 facts) | 150 | 250 |
| Drive memory (20 facts) | 150 | 250 |
| **Total with memory** | **7,000** | **19,500** |

**Memory overhead: ~300-500 tokens (2-4% increase)**

This is acceptable given the value provided.

---

## 12. References

- [ChatGPT Memory announcement](https://openai.com/blog/memory-and-new-controls-for-chatgpt) (Feb 2024)
- [Internal discussion: Auto-tagging exploration](./memory-system-v1.md)
- PageSpace schema: `packages/db/src/schema/`
- Activity logs: `packages/db/src/schema/monitoring.ts`
