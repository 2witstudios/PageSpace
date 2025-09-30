# PageSpace Claude Code Domain Expert Agents

This directory contains comprehensive system prompts for specialized Claude Code agents that have deep domain expertise over specific areas of the PageSpace codebase.

## Purpose

These agent prompts enable you to launch specialized Claude Code sub-agents for:
- **Feature auditing** - Review and validate specific system implementations
- **Domain guidance** - Get expert advice on architecture and patterns
- **Code review** - Domain-specific code quality checks
- **Documentation** - Update docs with current implementation details
- **Troubleshooting** - Debug issues within a specific subsystem
- **Implementation** - Build features following established patterns

## Agent Directory

### 0. Testing & Quality Assurance (1 agent)

#### [Test Agent - Comprehensive Testing & QA Expert](test-agent.md)
**Domains:** Unit/integration/E2E/security tests, Chrome DevTools MCP, browser automation, performance analysis
**Use for:** Running tests, debugging failures, coverage reports, browser testing, performance testing, visual regression
**Special Capabilities:** Full Chrome DevTools MCP integration for automated browser testing and performance analysis

### 1. Core Infrastructure (5 agents)

#### [Authentication & Security Expert](1-core-infrastructure/authentication-security-expert.md)
**Domains:** JWT tokens, CSRF protection, encryption, rate limiting, session management, password hashing
**Use for:** Security audits, auth flows, token management, login/signup implementation

#### [Database & Schema Expert](1-core-infrastructure/database-schema-expert.md)
**Domains:** Drizzle ORM, PostgreSQL, migrations, schema design, indexes, relations
**Use for:** Schema changes, migration creation, query optimization, database architecture

#### [Permissions & Authorization Expert](1-core-infrastructure/permissions-authorization-expert.md)
**Domains:** RBAC, drive membership, page permissions, access control, permission inheritance
**Use for:** Permission logic, access control bugs, sharing features, authorization flows

#### [Real-time Collaboration Expert](1-core-infrastructure/realtime-collaboration-expert.md)
**Domains:** Socket.IO, live sync, conflict resolution, event broadcasting, real-time state
**Use for:** Live collaboration features, socket events, real-time sync issues

#### [Monitoring & Analytics Expert](1-core-infrastructure/monitoring-analytics-expert.md)
**Domains:** Logging, tracking, performance metrics, error handling, usage analytics
**Use for:** Debugging, performance optimization, analytics implementation, monitoring setup

### 2. AI & Intelligence (3 agents)

#### [AI System Architect](2-ai-intelligence/ai-system-architect.md)
**Domains:** AI providers, message flow, streaming, model capabilities, provider factory
**Use for:** AI provider integration, streaming implementation, model switching, capability detection

#### [AI Tools & Integration Expert](2-ai-intelligence/ai-tools-integration-expert.md)
**Domains:** Tool calling, PageSpace tools, batch operations, search tools, task management
**Use for:** Creating new AI tools, tool permissions, batch operations, complex tool workflows

#### [AI Agents & Communication Expert](2-ai-intelligence/ai-agents-communication-expert.md)
**Domains:** Agent roles, agent-to-agent communication, custom agents, system prompts
**Use for:** Agent configuration, agent roles (PARTNER/PLANNER/WRITER), agent communication

### 3. Content & Workspace (4 agents)

#### [Pages & Content Expert](3-content-workspace/pages-content-expert.md)
**Domains:** Page types, content management, CRUD operations, tree structure, page hierarchy
**Use for:** New page types, content operations, tree manipulation, page lifecycle

#### [Drives & Workspace Expert](3-content-workspace/drives-workspace-expert.md)
**Domains:** Drive management, membership, invitations, drive hierarchy, ownership
**Use for:** Drive features, membership management, workspace organization, multi-tenancy

#### [File Processing Expert](3-content-workspace/file-processing-expert.md)
**Domains:** Uploads, processor service, image optimization, content-addressed storage
**Use for:** File upload features, image processing, processor service integration, storage

#### [Search & Discovery Expert](3-content-workspace/search-discovery-expert.md)
**Domains:** Regex search, glob patterns, multi-drive search, mentions, filtering
**Use for:** Search features, mention system, cross-drive queries, pattern matching

### 4. Frontend & UX (3 agents)

#### [Frontend Architecture Expert](4-frontend-ux/frontend-architecture-expert.md)
**Domains:** Next.js 15, App Router, components, state management, Zustand, SWR
**Use for:** Frontend architecture, component design, state management, routing

#### [Editor System Expert](4-frontend-ux/editor-system-expert.md)
**Domains:** Tiptap, Monaco, document state, auto-save, Prettier integration, rich text
**Use for:** Editor features, document management, content formatting, auto-save logic

#### [Canvas Dashboard Expert](4-frontend-ux/canvas-dashboard-expert.md)
**Domains:** Shadow DOM, custom HTML/CSS, navigation, sanitization, isolated rendering
**Use for:** Canvas features, custom dashboards, HTML/CSS rendering, security sanitization

### 5. API & Integration (2 agents)

#### [API Routes Expert](5-api-integration/api-routes-expert.md)
**Domains:** Next.js routes, async params, request handling, error responses, middleware
**Use for:** New API endpoints, request validation, error handling, API patterns

#### [MCP Integration Expert](5-api-integration/mcp-integration-expert.md)
**Domains:** MCP tokens, document operations, protocol integration, external tool access
**Use for:** MCP server implementation, external integrations, protocol compliance

## Usage Patterns

### Launching a Specialized Agent

Use the `Task` tool with the `general-purpose` agent type and include the system prompt content:

```typescript
// Example: Launch Database Expert for schema review
agent = launch_task({
  subagent_type: "general-purpose",
  description: "Review database schema",
  prompt: `${READ_FILE('docs/4.0-claude-agents/1-core-infrastructure/database-schema-expert.md')}

  Task: Review the current database schema and suggest indexes for performance optimization.`
});
```

### Common Workflows

#### Feature Audit
```
1. Read the relevant agent prompt
2. Launch agent with audit checklist
3. Agent reviews implementation against best practices
4. Agent provides findings and recommendations
```

#### Implementation Guidance
```
1. Describe the feature you want to build
2. Launch relevant domain expert
3. Agent provides architecture guidance
4. Agent suggests file locations and patterns
5. Implement following agent's guidance
```

#### Documentation Update
```
1. Launch domain expert
2. Ask agent to review current documentation
3. Agent identifies outdated information
4. Agent suggests specific updates
5. Apply documentation changes
```

#### Cross-Domain Tasks
```
1. Launch multiple specialized agents
2. Coordinate between agents for different aspects
3. Example: API Routes Expert + Permissions Expert for secure endpoint
```

## Agent Capabilities

### What These Agents Know
- ✅ Exact file paths and line numbers
- ✅ Current implementation patterns
- ✅ Database schema and relationships
- ✅ Function signatures and APIs
- ✅ Integration points between systems
- ✅ Best practices and anti-patterns
- ✅ Common bugs and solutions
- ✅ Documentation locations

### What They Can Do
- ✅ Code review and audit
- ✅ Architecture guidance
- ✅ Implementation suggestions
- ✅ Debug issue analysis
- ✅ Documentation updates
- ✅ Pattern identification
- ✅ Test case suggestions
- ✅ Security assessments

### What They Cannot Do
- ❌ Access runtime state
- ❌ Execute code directly
- ❌ Access external systems
- ❌ Make autonomous changes
- ❌ Access user data

## Best Practices

### When to Use Domain Experts

**✅ Good Use Cases:**
- Implementing features in a specific domain
- Auditing existing implementations
- Understanding complex subsystems
- Getting architecture guidance
- Debugging domain-specific issues
- Updating domain documentation

**❌ Avoid for:**
- Simple file edits
- General code formatting
- Tasks outside their domain
- Questions already answered in docs
- Tasks requiring multiple domains (use point-guard instead)

### Working with Multiple Agents

For complex features spanning multiple domains:
1. Use `point-guard` orchestrator agent
2. Point-guard will delegate to domain experts
3. Domain experts collaborate through point-guard
4. Results are coordinated and consolidated

### Agent Specialization Philosophy

Each agent is:
- **Narrow in scope** - Deep knowledge of specific area
- **Comprehensive in domain** - Knows everything about their area
- **Pattern-aware** - Understands established conventions
- **Context-rich** - Has full file paths and references
- **Audit-capable** - Can verify implementation quality

## Maintenance

### Keeping Agents Up-to-Date

When making significant changes to PageSpace:
1. Identify affected domains
2. Update relevant agent prompt files
3. Add new file paths and patterns
4. Update integration points
5. Revise best practices if needed
6. Update examples with new patterns

### Agent Prompt Structure

Each agent prompt follows this template:
1. **Identity** - Role and expertise
2. **Responsibilities** - What they handle
3. **Domain Knowledge** - Key concepts
4. **Critical Files** - Paths and locations
5. **Common Tasks** - Typical workflows
6. **Integration Points** - Connections to other systems
7. **Best Practices** - Standards and patterns
8. **Audit Checklist** - What to verify
9. **Usage Examples** - How to use this agent

## Contributing

When creating new features:
- Update relevant agent prompts with new patterns
- Add new file paths to critical files section
- Document new integration points
- Update audit checklists if new standards emerge
- Add examples of new patterns

## Quick Reference

| Need to... | Use This Agent |
|------------|---------------|
| Run tests or debug failures | Test Agent |
| Browser testing & performance | Test Agent (Chrome DevTools MCP) |
| Add authentication | Authentication & Security Expert |
| Modify database schema | Database & Schema Expert |
| Fix permission bugs | Permissions & Authorization Expert |
| Add real-time features | Real-time Collaboration Expert |
| Debug performance | Monitoring & Analytics Expert |
| Add AI provider | AI System Architect |
| Create AI tools | AI Tools & Integration Expert |
| Configure agents | AI Agents & Communication Expert |
| New page type | Pages & Content Expert |
| Drive features | Drives & Workspace Expert |
| File uploads | File Processing Expert |
| Search features | Search & Discovery Expert |
| Frontend components | Frontend Architecture Expert |
| Editor features | Editor System Expert |
| Canvas dashboards | Canvas Dashboard Expert |
| New API routes | API Routes Expert |
| MCP integration | MCP Integration Expert |

## Chrome DevTools MCP Integration

PageSpace integrates with Chrome DevTools through the Model Context Protocol, providing agents with powerful browser testing and debugging capabilities.

### Available to All Agents

Domain expert agents can now use Chrome DevTools MCP tools to:
- **Test their implementations** in a real browser environment
- **Debug visual issues** with screenshots and snapshots
- **Verify performance** with Core Web Vitals analysis
- **Check network requests** to validate API integration
- **Monitor console** for runtime errors
- **Test responsive design** across device sizes

### Primary Use Cases

**Test Agent:**
- Comprehensive testing suite management
- Performance analysis and optimization
- Visual regression testing
- E2E user flow verification

**Frontend Architecture Expert:**
- Component rendering verification
- Responsive layout testing
- Performance optimization
- Route navigation testing

**Canvas Dashboard Expert:**
- Shadow DOM rendering verification
- Custom HTML/CSS testing
- Navigation interception validation
- Visual output confirmation

**Editor System Expert:**
- Tiptap/Monaco editor testing
- Auto-save functionality verification
- Real-time collaboration testing
- User interaction validation

**Pages & Content Expert:**
- Page CRUD operation testing
- Tree hierarchy rendering verification
- Form submission validation
- UI interaction testing

### How Agents Use Chrome DevTools

Agents can use these tools without explicit user instruction when it helps verify their work:

```
Example: Pages & Content Expert implementing page creation

1. Implement page creation API endpoint
2. Implement frontend form component
3. Use Chrome DevTools to:
   - Navigate to dashboard
   - Fill and submit creation form
   - Verify page appears in tree
   - Check for console errors
   - Validate API request/response
4. Report success with screenshots as proof
```

For full Chrome DevTools MCP documentation, see [Test Agent](test-agent.md) system prompt section: "Chrome DevTools MCP Integration".

---

## See Also

- [CLAUDE.md](../CLAUDE.md) - Main Claude Code integration guide
- [Functions List](../1.0-overview/1.5-functions-list.md) - Complete function reference
- [API Routes](../1.0-overview/1.4-api-routes-list.md) - All API endpoints
- [Architecture Overview](../2.0-architecture/) - System architecture docs
- [Testing Status](../TESTING-SUITE-STATUS.md) - Current test coverage and browser testing phase