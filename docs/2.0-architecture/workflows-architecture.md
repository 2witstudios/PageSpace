# Workflows System Architecture

## Overview

The Workflows system enables sequential AI agent execution with context passing, providing a powerful framework for multi-step processes in PageSpace. This document describes the architecture, design decisions, and implementation details.

## System Architecture

### High-Level Components

```
┌─────────────────────────────────────────────────────────────┐
│                        Frontend Layer                        │
├─────────────────────────────────────────────────────────────┤
│  • Discovery UI (Browse/Search Templates)                   │
│  • Builder UI (Create/Edit Templates)                       │
│  • Execution UI (Monitor Running Workflows)                 │
│  • SWR Hooks (Data Fetching & Caching)                     │
└────────────────────┬────────────────────────────────────────┘
                     │
                     │ REST API
                     │
┌────────────────────▼────────────────────────────────────────┐
│                    API Routes Layer                          │
├─────────────────────────────────────────────────────────────┤
│  Template API:                                               │
│    • GET/POST /api/workflows/templates                      │
│    • GET/PATCH/DELETE /api/workflows/templates/[id]         │
│                                                              │
│  Execution API:                                              │
│    • POST /api/workflows/executions (start)                 │
│    • GET /api/workflows/executions (list)                   │
│    • GET /api/workflows/executions/[id] (status)            │
│    • POST /api/workflows/executions/[id]/next (execute)     │
│    • POST /api/workflows/executions/[id]/input (submit)     │
│    • POST /api/workflows/executions/[id]/pause|resume|cancel │
│                                                              │
│  Helper API:                                                 │
│    • GET /api/workflows/agents (list AI_CHAT pages)         │
└────────────────────┬────────────────────────────────────────┘
                     │
                     │
┌────────────────────▼────────────────────────────────────────┐
│                   Business Logic Layer                       │
├─────────────────────────────────────────────────────────────┤
│  Workflow Execution Engine:                                  │
│    • executeWorkflowStep() - Core step execution            │
│    • processPromptTemplate() - Variable substitution        │
│    • updateExecutionContext() - Context management          │
│    • getExecutionState() - State retrieval                  │
│    • executeAgentStep() - AI agent integration              │
│                                                              │
│  State Management:                                           │
│    • Execution lifecycle (running → paused/completed/failed) │
│    • Step status tracking                                   │
│    • Context accumulation                                   │
│    • Error handling & recovery                              │
└────────────────────┬────────────────────────────────────────┘
                     │
                     │
┌────────────────────▼────────────────────────────────────────┐
│                  AI Integration Layer                        │
├─────────────────────────────────────────────────────────────┤
│  • createAIProvider() - Provider factory                     │
│  • generateText() - Synchronous AI generation               │
│  • Tool filtering & permissions                             │
│  • Message persistence (database-first)                     │
│  • Agent configuration (model, system prompt, tools)        │
└────────────────────┬────────────────────────────────────────┘
                     │
                     │
┌────────────────────▼────────────────────────────────────────┐
│                     Database Layer                           │
├─────────────────────────────────────────────────────────────┤
│  Tables:                                                     │
│    • workflowTemplates - Template definitions               │
│    • workflowSteps - Step definitions                       │
│    • workflowExecutions - Running instances                 │
│    • workflowExecutionSteps - Step execution records        │
│    • chatMessages - AI conversation history                 │
│    • pages - AI agent pages (AI_CHAT type)                  │
└─────────────────────────────────────────────────────────────┘
```

## Database Schema

### Core Tables

#### workflowTemplates

Template definitions for reusable workflows.

```sql
CREATE TABLE workflow_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  drive_id TEXT NOT NULL REFERENCES drives(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT,
  tags TEXT[],
  is_public BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_workflow_templates_drive_id ON workflow_templates(drive_id);
CREATE INDEX idx_workflow_templates_created_by ON workflow_templates(created_by);
CREATE INDEX idx_workflow_templates_category ON workflow_templates(category);
CREATE INDEX idx_workflow_templates_is_public ON workflow_templates(is_public);
```

#### workflowSteps

Step definitions within templates.

```sql
CREATE TABLE workflow_steps (
  id TEXT PRIMARY KEY,
  workflow_template_id TEXT NOT NULL REFERENCES workflow_templates(id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  prompt_template TEXT NOT NULL,
  requires_user_input BOOLEAN NOT NULL DEFAULT false,
  input_schema JSONB,
  metadata JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_workflow_steps_template_id ON workflow_steps(workflow_template_id);
CREATE INDEX idx_workflow_steps_template_order ON workflow_steps(workflow_template_id, step_order);
```

#### workflowExecutions

Running workflow instances.

```sql
CREATE TYPE workflow_execution_status AS ENUM (
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled'
);

CREATE TABLE workflow_executions (
  id TEXT PRIMARY KEY,
  workflow_template_id TEXT NOT NULL REFERENCES workflow_templates(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  drive_id TEXT NOT NULL REFERENCES drives(id) ON DELETE CASCADE,
  status workflow_execution_status NOT NULL DEFAULT 'running',
  current_step_order INTEGER NOT NULL DEFAULT 0,
  accumulated_context JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMP NOT NULL DEFAULT NOW(),
  paused_at TIMESTAMP,
  completed_at TIMESTAMP,
  failed_at TIMESTAMP,
  error_message TEXT
);

-- Indexes
CREATE INDEX idx_workflow_executions_template_id ON workflow_executions(workflow_template_id);
CREATE INDEX idx_workflow_executions_user_id ON workflow_executions(user_id);
CREATE INDEX idx_workflow_executions_drive_id ON workflow_executions(drive_id);
CREATE INDEX idx_workflow_executions_status ON workflow_executions(status);
CREATE INDEX idx_workflow_executions_user_status ON workflow_executions(user_id, status);
CREATE INDEX idx_workflow_executions_drive_status ON workflow_executions(drive_id, status);
```

#### workflowExecutionSteps

Individual step execution records.

```sql
CREATE TYPE workflow_step_status AS ENUM (
  'pending',
  'running',
  'completed',
  'failed',
  'skipped'
);

CREATE TABLE workflow_execution_steps (
  id TEXT PRIMARY KEY,
  workflow_execution_id TEXT NOT NULL REFERENCES workflow_executions(id) ON DELETE CASCADE,
  workflow_step_id TEXT REFERENCES workflow_steps(id) ON DELETE SET NULL,
  step_order INTEGER NOT NULL,
  status workflow_step_status NOT NULL DEFAULT 'pending',
  agent_input JSONB,
  agent_output JSONB,
  user_input JSONB,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  error_message TEXT
);

-- Indexes
CREATE INDEX idx_workflow_execution_steps_execution_id ON workflow_execution_steps(workflow_execution_id);
CREATE INDEX idx_workflow_execution_steps_step_id ON workflow_execution_steps(workflow_step_id);
CREATE INDEX idx_workflow_execution_steps_execution_order ON workflow_execution_steps(workflow_execution_id, step_order);
CREATE INDEX idx_workflow_execution_steps_status ON workflow_execution_steps(status);
```

## Execution Engine

### Core Execution Flow

```typescript
// 1. Start Execution
async function createWorkflowExecution(
  templateId: string,
  userId: string,
  driveId: string,
  initialContext?: Record<string, unknown>
): Promise<string> {
  // Create execution record
  const execution = await db.insert(workflowExecutions).values({
    workflowTemplateId: templateId,
    userId,
    driveId,
    status: 'running',
    currentStepOrder: 0,
    accumulatedContext: { initialContext: initialContext ?? {} }
  });

  // Create execution step records for all template steps
  const steps = await getTemplateSteps(templateId);
  await db.insert(workflowExecutionSteps).values(
    steps.map(step => ({
      workflowExecutionId: execution.id,
      workflowStepId: step.id,
      stepOrder: step.stepOrder,
      status: 'pending'
    }))
  );

  return execution.id;
}

// 2. Execute Step
async function executeWorkflowStep(
  executionId: string,
  stepNumber: number
): Promise<ExecutionResult> {
  // Get execution state
  const state = await getExecutionState(executionId);

  // Get step definition
  const stepDef = await getStepDefinition(state.execution.workflowTemplateId, stepNumber);

  // Process prompt template with context
  const processedPrompt = processPromptTemplate(
    stepDef.promptTemplate,
    state.execution.accumulatedContext
  );

  // Update step status to 'running'
  await updateStepStatus(state.currentStep.id, 'running');

  // Execute AI agent
  const agentResult = await executeAgentStep(
    stepDef.agentId,
    processedPrompt,
    state.execution.userId,
    executionId
  );

  // Save agent output
  const agentOutput = {
    type: 'text',
    content: agentResult.content,
    metadata: agentResult.metadata
  };

  await db.update(workflowExecutionSteps)
    .set({
      status: 'completed',
      agentOutput,
      completedAt: new Date()
    })
    .where(eq(workflowExecutionSteps.id, state.currentStep.id));

  // Update accumulated context
  const updatedContext = {
    ...state.execution.accumulatedContext,
    [`step${stepNumber}Output`]: agentResult.content,
    [`step${stepNumber}Metadata`]: agentResult.metadata
  };

  await updateExecutionContext(executionId, updatedContext);

  // Check if workflow is complete or has more steps
  const hasMoreSteps = stepNumber < state.totalSteps - 1;

  if (!hasMoreSteps) {
    // Mark execution as completed
    await db.update(workflowExecutions)
      .set({ status: 'completed', completedAt: new Date() })
      .where(eq(workflowExecutions.id, executionId));
  } else {
    // Advance to next step
    await db.update(workflowExecutions)
      .set({ currentStepOrder: stepNumber + 1 })
      .where(eq(workflowExecutions.id, executionId));
  }

  return { success: true, output: agentOutput };
}
```

### Context Passing

The accumulated context is a JSON object that grows with each step:

```typescript
{
  initialContext: {
    topic: "AI Workflows",
    audience: "developers"
  },
  step0Output: "Research findings...",
  step0Metadata: { executionTimeMs: 2500, tokenUsage: { total: 1200 } },
  step1Output: "Outline content...",
  step1Metadata: { executionTimeMs: 1800, tokenUsage: { total: 800 } },
  step1UserInput: { feedback: "Looks good!" }
}
```

### Template Variable Substitution

```typescript
function processPromptTemplate(
  template: string,
  context: Record<string, unknown>
): string {
  // Replace {{context}} with full JSON
  if (template.includes('{{context}}')) {
    template = template.replace('{{context}}', JSON.stringify(context, null, 2));
  }

  // Replace {{initialContext.key}}
  template = template.replace(/\{\{initialContext\.(\w+)\}\}/g, (match, key) => {
    return String(context.initialContext?.[key] ?? match);
  });

  // Replace {{stepN.output}}
  template = template.replace(/\{\{step(\d+)\.output\}\}/g, (match, stepNum) => {
    return String(context[`step${stepNum}Output`] ?? match);
  });

  // Replace {{stepN.userInput}}
  template = template.replace(/\{\{step(\d+)\.userInput\}\}/g, (match, stepNum) => {
    const userInput = context[`step${stepNum}UserInput`];
    return userInput ? JSON.stringify(userInput, null, 2) : match;
  });

  // Replace {{userInput}} (current step)
  // This is handled at execution time when user input is available

  return template;
}
```

### AI Agent Integration

```typescript
async function executeAgentStep(
  agentId: string,
  processedPrompt: string,
  userId: string,
  executionId: string
): Promise<{ content: string; metadata: Record<string, unknown> }> {
  // 1. Get agent page (AI_CHAT type)
  const agent = await db.select()
    .from(pages)
    .where(and(eq(pages.id, agentId), eq(pages.type, 'AI_CHAT')))
    .limit(1);

  if (!agent) throw new Error('Agent not found');

  // 2. Create conversation ID for workflow
  const conversationId = `workflow-${executionId}`;

  // 3. Create user message in agent's page
  const userMessage = await db.insert(chatMessages).values({
    pageId: agentId,
    conversationId,
    role: 'user',
    content: { parts: [{ type: 'text', text: processedPrompt }] },
    userId
  });

  // 4. Create AI provider with agent's configuration
  const providerRequest: ProviderRequest = {
    userId,
    pageId: agentId,
    aiProvider: agent.aiProvider,
    aiModel: agent.aiModel
  };

  const { provider, modelId } = await createAIProvider(providerRequest);

  // 5. Prepare system prompt and tools
  const systemPrompt = agent.systemPrompt || 'You are a helpful AI assistant.';
  const enabledTools = agent.enabledTools || undefined;
  const filteredTools = enabledTools
    ? pageSpaceTools.filter(t => enabledTools.includes(t.name))
    : new ToolPermissionFilter().filterToolsByRole('PARTNER', pageSpaceTools);

  // 6. Execute AI generation (synchronous)
  const result = await generateText({
    model: provider.languageModel(modelId),
    system: systemPrompt,
    prompt: processedPrompt,
    tools: filteredTools,
    maxSteps: 10
  });

  // 7. Save AI response
  const assistantMessage = await db.insert(chatMessages).values({
    pageId: agentId,
    conversationId,
    role: 'assistant',
    content: { parts: [{ type: 'text', text: result.text }] },
    userId: null,
    toolCalls: result.toolCalls?.length ? result.toolCalls : null,
    toolResults: result.toolResults?.length ? result.toolResults : null
  });

  // 8. Return result with metadata
  return {
    content: result.text,
    metadata: {
      conversationId,
      userMessageId: userMessage.id,
      assistantMessageId: assistantMessage.id,
      agentId,
      agentTitle: agent.title,
      provider: providerRequest.aiProvider,
      model: modelId,
      executionTimeMs: Date.now() - startTime,
      tokenUsage: result.usage || {},
      toolCallsCount: result.toolCalls?.length || 0,
      toolResultsCount: result.toolResults?.length || 0
    }
  };
}
```

## Frontend Architecture

### Component Hierarchy

```
WorkflowsPage (Server Component)
  └─ WorkflowsPageClient (Client Component)
      ├─ WorkflowFilters
      │   ├─ Search Input
      │   ├─ Category Select
      │   └─ Tag Multi-Select
      │
      └─ WorkflowTemplateList
          └─ WorkflowTemplateCard (multiple)
              ├─ Template Metadata
              ├─ Start Button
              └─ View Details Button

WorkflowTemplateDetailPage
  └─ WorkflowTemplateDetail
      ├─ Template Header
      ├─ Step Breakdown
      ├─ Start Workflow Button
      └─ Edit Button (if permitted)

WorkflowExecutionPage
  └─ WorkflowExecutionView
      ├─ WorkflowProgressBar
      ├─ WorkflowUserInputForm (conditional)
      ├─ WorkflowStepList
      │   └─ WorkflowStepCard (multiple)
      ├─ WorkflowAccumulatedContext
      └─ WorkflowExecutionControls

WorkflowBuilderPage
  ├─ WorkflowMetadataForm
  ├─ WorkflowStepBuilder
  │   └─ WorkflowStepCardBuilder (multiple)
  │       └─ WorkflowInputSchemaBuilder (conditional)
  └─ WorkflowPreview
```

### State Management

**SWR Hooks for Server State:**
- `useWorkflowTemplates(filters)` - List templates with client-side caching
- `useWorkflowTemplate(id)` - Single template with steps
- `useWorkflowExecutions(filters)` - User's executions with auto-refresh
- `useWorkflowExecution(id)` - Single execution with real-time polling

**Local State:**
- Form state in builder (React Hook Form or useState)
- Filter state in discovery UI
- User input state in execution view

**Auto-refresh Strategy:**
- Executions: Poll every 5s when any execution is 'running'
- Single execution: Poll every 2s when status is 'running'
- Stop polling when status changes to 'completed', 'failed', or 'cancelled'

### Real-time Updates

Auto-execution hook pattern:

```typescript
function useAutoExecuteSteps(executionId: string) {
  const { execution, refresh } = useWorkflowExecution(executionId);
  const { executeNextStep } = useExecutionControls(executionId);
  const lastStepRef = useRef<number>(-1);

  useEffect(() => {
    if (!execution) return;

    const currentStep = execution.steps.find(
      s => s.stepOrder === execution.currentStepOrder
    );

    // Check if current step just completed and doesn't require input
    const shouldAutoExecute =
      execution.status === 'running' &&
      currentStep?.status === 'completed' &&
      !currentStep?.requiresUserInput &&
      lastStepRef.current !== execution.currentStepOrder;

    if (shouldAutoExecute) {
      lastStepRef.current = execution.currentStepOrder;
      executeNextStep();
    }
  }, [execution, executeNextStep]);
}
```

## Permission Model

### Template Permissions

- **Create**: User must have write access to the drive
- **Read**: User must have access to the drive OR template must be `isPublic`
- **Update**: User must be drive owner or admin
- **Delete**: User must be drive owner or admin (and no active executions exist)

### Execution Permissions

- **Create**: User must have access to the template (read permission)
- **Read**: User must be the execution owner
- **Control** (pause/resume/cancel): User must be the execution owner
- **Submit Input**: User must be the execution owner

### Agent Access

- When a workflow executes an agent, the agent's AI provider configuration, system prompt, and tool permissions are respected
- The execution runs with the user's permissions (workflow executor's userId)
- Messages are saved to the agent's page with proper access control

## Design Decisions

### Why Sequential, Not DAG?

**Decision**: Workflows are strictly sequential (Step 0 → Step 1 → Step 2 → ...)

**Rationale**:
- Simplicity: Easy to understand and create
- AI-native: Conditional logic handled by prompts, not code
- Most use cases: 80% of workflows are naturally sequential
- YAGNI: Can add parallel execution later if needed

### Why AI-Driven Conditional Logic?

**Decision**: Use prompts for conditional logic instead of programmatic branching

**Example**:
```
If the document has major issues:
  - Create revision plan
If the document is ready:
  - Provide approval
```

**Rationale**:
- Simpler for users to create
- More flexible (AI can handle nuanced conditions)
- Faster to implement
- Easier to maintain

### Why Synchronous Execution?

**Decision**: Use `generateText()` (synchronous) instead of streaming

**Rationale**:
- Workflows need complete outputs before next step
- Context passing requires full responses
- Simpler state management
- Better for long-running multi-step processes

### Why Database-First Message Storage?

**Decision**: Save AI messages to database before and after generation

**Rationale**:
- Audit trail: Complete conversation history
- Debugging: Can review agent inputs and outputs
- Consistency: Matches PageSpace's AI chat pattern
- Traceability: Link workflow executions to conversations

## Performance Considerations

### Indexing Strategy

All foreign keys are indexed:
- `workflowTemplates.driveId`
- `workflowSteps.workflowTemplateId`
- `workflowExecutions.userId`, `driveId`, `status`
- `workflowExecutionSteps.workflowExecutionId`

Composite indexes for common queries:
- `workflowExecutions(userId, status)` - User's active executions
- `workflowExecutions(driveId, status)` - Drive's active executions
- `workflowSteps(workflowTemplateId, stepOrder)` - Ordered step retrieval

### Query Optimization

- Template listing uses SQL aggregation for step counts (single query)
- Execution state uses joins to fetch all related data (single query)
- Context is stored as JSONB for efficient updates and retrieval

### Caching

- SWR provides client-side caching with automatic revalidation
- Template data is relatively static (cache aggressively)
- Execution data is dynamic (cache with short TTL, auto-refresh)

## Future Enhancements

### Potential Features

1. **Parallel Steps**: Execute multiple steps concurrently
2. **Conditional Branching**: Programmatic if/else logic
3. **Loops**: Repeat steps based on conditions
4. **Sub-workflows**: Nest workflows within workflows
5. **Webhooks**: Trigger external systems on events
6. **Scheduled Executions**: Cron-like workflow scheduling
7. **Workflow Templates Marketplace**: Share and monetize templates
8. **Analytics**: Track workflow performance metrics
9. **Version Control**: Template versioning and rollback
10. **Collaborative Editing**: Real-time multi-user template editing

### Migration Path

The current architecture supports these enhancements:
- JSONB `metadata` fields allow adding new data without schema changes
- Sequential execution can be extended to parallel with step dependencies
- Template variables can be extended with new syntax
- Status enums can be extended with new states

## Testing Strategy

### Unit Tests
- Template CRUD operations
- Execution engine logic
- Prompt template processing
- Context management
- Permission checks

### Integration Tests
- API endpoint behavior
- Database transactions
- AI agent integration
- Error handling

### E2E Tests
- Complete workflow execution
- User input collection
- Pause/resume/cancel flows
- Template creation and editing

## Monitoring & Observability

### Logging

All API routes use `loggers.api` for structured logging:
- Request parameters
- Execution timing
- Error details
- State transitions

### Metrics to Track

- Workflow execution duration
- Step execution duration
- Success/failure rates
- User adoption (active workflows)
- Template popularity
- AI token usage per workflow

### Error Tracking

- Failed executions with full context
- Step failures with agent details
- User input validation errors
- Permission violations

## Security Considerations

### Input Validation

- All API inputs validated with Zod schemas
- SQL injection prevented by Drizzle ORM parameterized queries
- XSS prevented by React's automatic escaping
- CSRF protection via JWT tokens

### Permission Enforcement

- All endpoints verify authentication
- Drive permissions checked for template access
- Execution ownership verified for control actions
- Agent access controlled by page permissions

### Data Privacy

- User data isolated by userId
- Drive data isolated by driveId
- Context data stored as JSONB (encrypted at rest if DB encrypted)
- No PII in logs unless necessary for debugging

## Conclusion

The Workflows system provides a robust, scalable foundation for multi-step AI agent processes in PageSpace. The architecture prioritizes simplicity, maintainability, and extensibility while providing powerful capabilities for complex workflows.

Key strengths:
- ✅ Simple, intuitive design
- ✅ AI-native conditional logic
- ✅ Robust context passing
- ✅ Full audit trail
- ✅ Extensible architecture
- ✅ Production-ready implementation

The system is ready for deployment and can be enhanced with additional features as user needs evolve.
