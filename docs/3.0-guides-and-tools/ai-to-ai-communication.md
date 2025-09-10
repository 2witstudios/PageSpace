# AI-to-AI Communication Feature Design

**Status**: Design Phase  
**Priority**: High Value, Low Complexity  
**Estimated Development**: 1-2 Days  
**Last Updated**: 2025-09-10

## Overview

Enable AI agents within PageSpace to consult and communicate with other AI agents, creating a collaborative multi-agent workspace where specialized agents can work together to provide comprehensive responses.

## Use Cases

### **Primary Scenarios**

**Global Assistant → Specialist Agents**
- "Ask our finance agent about Q4 budget status"
- "Have our code assistant review this authentication module" 
- "Check with the marketing agent about campaign performance"

**Project Manager Agent → Team Specialists**
- "Get technical feasibility from our dev agent"
- "Ask design agent for UI mockup feedback"
- "Consult legal agent about compliance requirements"

**Multi-Agent Workflows**
- Research agent gathers data → Analysis agent processes → Writing agent creates report
- Support agent identifies issue → Technical agent provides solution → Documentation agent updates KB

### **Advanced Scenarios**

**Parallel Consultation**
- Global agent asks 3 specialists simultaneously and synthesizes responses
- Decision-making agent consults multiple experts before recommendations

**Chain Delegation**
- Agent A → Agent B → Agent C → synthesized final response
- Complex workflows requiring multiple specialized steps

## Architecture Overview

### **Core Principle: Ephemeral Cross-Agent Interactions**

```
┌─────────────────┐    ask_agent()     ┌─────────────────┐
│   Global Agent  │ ──────────────────►│  Finance Agent  │
│                 │                    │                 │
│ Conversation:   │    Tool Response   │ Conversation:   │
│ • User msgs     │ ◄──────────────────│ • User msgs     │
│ • Tool calls    │                    │ • [No pollution]│
│ • Agent responses│                   │                 │
└─────────────────┘                    └─────────────────┘
```

**Key Architecture Points:**
- Target agent loads its full conversation history for context
- Target agent processes with its system prompt and enabled tools
- Response returns as tool result to requesting agent
- NO persistence to target agent's conversation history
- Requesting agent's conversation naturally includes the tool call/response

## Implementation Specification

### **1. New Tool: `ask_agent`**

```typescript
// Location: apps/web/src/lib/ai/tools/agent-communication-tools.ts
ask_agent: tool({
  description: 'Consult another AI agent in the workspace for specialized knowledge or assistance',
  inputSchema: z.object({
    agentPath: z.string().describe('Semantic path to the agent (e.g., "/finance/Finance Assistant")'),
    agentId: z.string().describe('Unique ID of the AI agent page'), 
    question: z.string().describe('Question or request for the target agent'),
    context: z.string().optional().describe('Additional context about why you\'re asking')
  })
})
```

### **2. Implementation Flow**

#### **Phase 1: Agent Discovery & Validation**
```typescript
// 1. Validate agent exists and is AI_CHAT type
const targetAgent = await db.query.pages.findFirst({
  where: and(eq(pages.id, agentId), eq(pages.type, 'AI_CHAT'))
});

// 2. Check user permissions (inherit requesting user's permissions)
const canAccess = await canUserViewPage(userId, agentId);
const canInteract = await canUserEditPage(userId, agentId);
```

#### **Phase 2: Context Loading**
```typescript
// 3. Load target agent's conversation history
const agentHistory = await db.select()
  .from(chatMessages)
  .where(eq(chatMessages.pageId, agentId))
  .orderBy(asc(chatMessages.createdAt));

// 4. Load agent configuration
const agentConfig = {
  systemPrompt: targetAgent.systemPrompt,
  enabledTools: targetAgent.enabledTools,
  aiProvider: targetAgent.aiProvider,
  aiModel: targetAgent.aiModel
};
```

#### **Phase 3: Agent Processing**
```typescript
// 5. Build message chain for target agent
const messages = [
  ...convertHistoryToUIMessages(agentHistory),
  {
    role: 'user',
    content: `${context ? `Context: ${context}\n\n` : ''}${question}`
  }
];

// 6. Process with target agent's configuration (in-memory only)
const response = await streamText({
  model: getConfiguredModel(agentConfig),
  system: agentConfig.systemPrompt + contextPrompts,
  messages: convertToModelMessages(messages),
  tools: filterTools(pageSpaceTools, agentConfig.enabledTools),
  // NO onFinish callback = no persistence
});
```

#### **Phase 4: Response Handling**
```typescript
// 7. Extract and return response
const agentResponse = await response.text();
return {
  success: true,
  agent: targetAgent.title,
  agentPath: agentPath,
  question: question,
  response: agentResponse,
  context: context,
  // Optional metadata
  usedTools: extractToolsUsed(response),
  processingTime: Date.now() - startTime
};
```

### **3. Security & Permission Model**

#### **Permission Inheritance**
- **User Context**: Target agent operates with requesting user's permissions
- **Tool Access**: Limited to target agent's configured enabled tools  
- **Drive Boundaries**: Respects existing drive access controls
- **Page Access**: Target agent can only access pages user can access

#### **Security Safeguards**
```typescript
// Validate chain depth to prevent infinite recursion
if (context.agentCallDepth > MAX_AGENT_DEPTH) {
  throw new Error('Maximum agent consultation depth exceeded');
}

// Audit trail for cross-agent interactions
await logAgentInteraction({
  requestingAgent: context.currentAgentId,
  targetAgent: agentId, 
  userId: userId,
  question: question,
  timestamp: new Date()
});
```

## User Experience Examples

### **Example 1: Budget Inquiry**
```
User: "What's our financial status for Q4?"

Global Agent: "Let me consult our Finance Agent for the most current financial analysis..."

🔧 [Tool: ask_agent]
   Agent: Finance Assistant (/finance/Finance Assistant)
   Question: "What's our financial status for Q4?"
   
📋 [Tool Response]
   Finance Agent: "Q4 financial status shows 85% budget utilization with projected 3% savings. 
   Based on our earlier discussion about the 18-month runway and upcoming Q1 lease renewal, 
   we're in a strong position. Key metrics: Revenue up 12% vs Q3, expenses controlled at 
   97% of budget, cash flow positive for 6 consecutive months."

Global Agent: "Based on the Finance Agent's analysis, your Q4 financial status is excellent. 
You're at 85% budget utilization with 3% projected savings, revenue is up 12% from Q3, and 
you're maintaining positive cash flow. The Finance Agent noted this positions you well for 
the upcoming Q1 lease renewal we discussed previously."
```

### **Example 2: Multi-Agent Code Review**
```
User: "Review the new authentication system"

Project Manager Agent: "I'll coordinate a comprehensive review with our technical specialists..."

🔧 [Tool: ask_agent]
   Agent: Security Specialist (/dev/Security Agent)
   Question: "Review authentication system for security vulnerabilities"
   Context: "User requesting comprehensive auth system review"

📋 [Tool Response - Security Agent]
   "Security analysis complete: Found 1 critical issue with session handling, 
   2 moderate concerns with password policies. JWT implementation is solid. 
   Recommend implementing refresh token rotation."

🔧 [Tool: ask_agent]  
   Agent: Code Quality Agent (/dev/Code Reviewer)
   Question: "Review authentication system for code quality and maintainability"
   
📋 [Tool Response - Code Agent]
   "Code quality review: Architecture is clean, good separation of concerns. 
   Identified 3 optimization opportunities and 1 performance improvement. 
   Test coverage at 89%. Recommend refactoring auth middleware for better reusability."

Project Manager Agent: "Comprehensive authentication review complete! 

**Security Assessment** (Security Specialist):
- 1 critical session handling issue requiring immediate attention
- Recommend refresh token rotation implementation
- JWT implementation approved

**Code Quality Assessment** (Code Reviewer):  
- Clean architecture with good separation of concerns
- 89% test coverage (good)
- 3 optimization opportunities identified
- Middleware refactoring recommended

Priority: Address the critical security issue first, then implement the optimization suggestions. Overall system is solid with targeted improvements needed."
```

## Implementation Phases

### **Phase 1: Core Functionality (Day 1)**
- [ ] Create `agent-communication-tools.ts`
- [ ] Implement `ask_agent` tool
- [ ] Add permission validation
- [ ] Basic agent discovery and querying
- [ ] Export in main ai-tools.ts

### **Phase 2: Enhanced Features (Day 2)**  
- [ ] Add recursion depth limiting
- [ ] Implement agent interaction logging
- [ ] Add context preservation between calls
- [ ] Error handling and fallbacks
- [ ] Performance optimizations

### **Phase 3: Advanced Capabilities (Future)**
- [ ] Parallel agent consultation
- [ ] Agent workflow definitions  
- [ ] Smart agent routing
- [ ] Response aggregation
- [ ] Agent collaboration patterns

## Technical Considerations

### **Performance Optimization**

#### **Caching Strategy**
```typescript
// Cache agent configurations to avoid repeated DB queries
const agentConfigCache = new Map<string, AgentConfig>();

// Cache conversation histories with TTL
const conversationCache = new Map<string, {
  messages: UIMessage[],
  timestamp: number,
  ttl: number
}>();
```

#### **Concurrent Processing**
```typescript
// Parallel agent consultation
const responses = await Promise.all([
  askAgent({ agentId: 'finance', question: 'Budget status?' }),
  askAgent({ agentId: 'sales', question: 'Pipeline status?' }),
  askAgent({ agentId: 'operations', question: 'Capacity status?' })
]);
```

### **Error Handling Strategy**

#### **Graceful Degradation**
```typescript
try {
  const response = await askAgent(params);
  return response;
} catch (error) {
  if (error.code === 'AGENT_UNAVAILABLE') {
    return `The ${agentPath} agent is currently unavailable. Please try again later.`;
  } else if (error.code === 'PERMISSION_DENIED') {
    return `I don't have permission to consult the ${agentPath} agent on your behalf.`;
  }
  throw error; // Re-throw unexpected errors
}
```

#### **Circuit Breaker Pattern**
```typescript
const agentCallLimiter = new Map<string, {
  failures: number,
  lastFailure: number,
  blocked: boolean
}>();
```

### **Monitoring & Analytics**

#### **Agent Interaction Metrics**
- Cross-agent call frequency
- Popular agent combinations  
- Response quality ratings
- Performance benchmarks
- Error rates and types

#### **Usage Patterns**
- Most consulted agents
- Average consultation chains
- User workflow identification
- Optimization opportunities

## Future Enhancements

### **Agent Orchestration Engine**
```typescript
// Define multi-agent workflows
const workflows = {
  'comprehensive_analysis': [
    { agent: 'research', task: 'gather_data' },
    { agent: 'analysis', task: 'process_insights' },
    { agent: 'writing', task: 'create_report' }
  ]
};
```

### **Smart Agent Routing**
```typescript
// Intelligent agent selection based on question type
const agentRouter = {
  'budget|financial|revenue': 'finance_agent',
  'code|development|bug': 'dev_agent', 
  'design|ui|ux': 'design_agent'
};
```

### **Collaborative Workspaces**
- Multi-agent discussion threads
- Shared context between agents
- Agent learning from interactions
- Workflow templates and automation

## Conclusion

The AI-to-AI communication feature transforms PageSpace from individual AI assistants into a collaborative multi-agent workspace. The architecture leverages existing infrastructure while maintaining clean separation of concerns.

**Key Benefits:**
- **Specialization**: Each agent maintains its expertise and context
- **Collaboration**: Agents can consult each other for complex tasks  
- **Clean Architecture**: No pollution of individual agent conversations
- **Permission-Safe**: Full security model inheritance
- **Scalable**: Works with unlimited agents and complexity levels

**Development Advantage:**
The existing PageSpace architecture makes this feature surprisingly easy to implement, requiring minimal new code while providing maximum functionality enhancement.

---

**Next Steps:**
1. Review and refine this design document
2. Create implementation plan with detailed tasks
3. Begin Phase 1 development
4. Test with real-world scenarios
5. Gather user feedback and iterate