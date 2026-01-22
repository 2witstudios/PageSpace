# AI Architecture

> Provider abstraction, AI SDK, multi-model support

## The Decision

PageSpace's AI architecture supports multiple providers (OpenRouter, Google, Anthropic, OpenAI, xAI, Ollama) through a unified abstraction layer built on Vercel's AI SDK.

## Key Architectural Choices

### Vercel AI SDK Foundation

**The Choice**: Build on `ai` (Vercel AI SDK) as the core abstraction.

**Why**:
- Streaming-first design
- Consistent interface across providers
- Tool calling support
- React hooks for client integration
- Active development and maintenance

**Trade-offs**:
- Another abstraction layer
- Version churn as SDK evolves
- Some provider-specific features harder to access

### Provider Abstraction

**The Choice**: Support multiple AI providers through a factory pattern.

**Why**:
- No vendor lock-in
- Cost optimization (route to cheapest capable model)
- Fallback options if one provider is down
- Local models (Ollama) for privacy-sensitive use cases

**Supported Providers**:
- `@ai-sdk/google` - Gemini models
- `@ai-sdk/anthropic` - Claude models
- `@ai-sdk/openai` - GPT models
- `@ai-sdk/xai` - Grok models
- `@openrouter/ai-sdk-provider` - Multi-model routing
- Ollama - Local models

### AI-to-AI Communication

**The Choice**: Enable AI agents to communicate with each other.

**Why**:
- Complex tasks benefit from specialized agents
- Different models have different strengths
- Delegation patterns for efficiency

*Introduced in Era 2 (Foundation) - September 10, 2025*

**Key Commits**:
- `38afdc9eb050` - "AI to AI communication"
- `93412039e702` - "conversation rendering for ai to ai"
- `0c003242e024` - "list agents and list agents across drives"

**Implementation Details**:
- Custom agents can be created via tool calls
- Agents can discover other agents across drives
- Special conversation rendering for AI-to-AI threads

### Tool Calling Architecture

**The Choice**: Rich tool integration for AI capabilities.

**Why**:
- AI can interact with PageSpace (create pages, search, etc.)
- Extends AI beyond text generation
- Enables autonomous workflows

**Tool Categories**:
- Document operations
- Search and discovery
- Batch operations
- Web search tools

## Message Parts Structure

All AI messages use a parts-based structure:

```typescript
const message = {
  parts: [
    { type: 'text', text: "Content here" }
  ]
};
```

This enables:
- Mixed content types
- Tool call results inline
- Future extensibility

## Evolution Through Commits

### Era 1: Genesis (Aug 2025)
- Basic AI tool setup
- MCP integration for external AI tools

### Era 2: Foundation (Sep 7-15, 2025)
- **AI-to-AI Communication** (`38afdc9eb050`): Agents can communicate with each other
- **Custom Agents** (`839f489d5512`): Agents created via tool calls
- **Model Routing** (`11bbf3428566`): Dynamic model selection based on task
- **Nested Tool Calls** (`79b41f4ff392`): AI can chain operations

### Era 3: AI Awakening (Sep 19-30, 2025)
- **Ollama Integration** (`a8aac666ec58`): Local model support for privacy/development
- **GLM Support** (`5eca94599bd5`): New model provider, set as default
- **Anthropic Fixes** (`828a85ac6a36`): Provider stability improvements
- **Batch Operations** (`a8fc9713d1c8`): Fixed batch processing

**Key Insight**: Era 3 shows the challenge of multi-provider support. Each provider has quirks requiring specific fixes (Anthropic, batch operations). The abstraction layer helps, but doesn't eliminate provider-specific issues.

### Era 4: Collaboration (Oct 1-15, 2025)
- **Global Assistant State** (`b896addae1dc`): Context preservation across navigation
- **AI Retry/Edit** (`57fd6cfc57a0`): User iteration on AI responses
- **Stop Generation** (`458fa8086ecd`): Mid-stream control

### Era 5: Polish (Oct 16-31, 2025)
- **LM Studio Integration** (`42010861504a`): Second local model provider
- **Shared AI Streaming State** (`dffd9bd8d785`): Fixed state management for streaming

**Key Insight**: Local model support expanded from Ollama to LM Studio, showing commitment to privacy-first and offline-capable AI. The streaming state fixes show ongoing challenges with real-time AI UI.

### Era 6: Enterprise (Nov 1-15, 2025)
- **AI Usage Monitoring** (`2805493940653`): Real-time token tracking for cost transparency
- **Agent Conversation History** (`b2743abfc72f`): Persistent memory for `ask_agent` tool
- **Tool Call UI Redesign** (`563da278a444`): Grouped collapsible pattern for cleaner UX
- **Tool Consolidation** (`abb00670ad9d`): Reduced cognitive overhead by consolidating redundant tools
- **GLM Web Search** (`43d6851a6223`): External web search capability for AI agents

**Key Insight**: Era 6 shows AI system maturation. Usage tracking provides transparency, agent memory enables sophisticated interactions, and tool consolidation shows focus on user experience over raw capability.

### Era 7+
*To be documented as commits are processed.*

---

*Last updated: 2026-01-22 | Version: 5*
