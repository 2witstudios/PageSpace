# Workflows - Agent Sequencing System Database Schema

## Overview

The Workflows system enables users to create multi-step AI agent workflows with conditional logic, context accumulation, and user input decision points. This document describes the database schema design, rationale, and usage patterns.

## Schema Components

### 1. Enums

**WorkflowExecutionStatus**
- `running` - Workflow is currently executing
- `paused` - Workflow is waiting for user input
- `completed` - Workflow finished successfully
- `failed` - Workflow encountered an error
- `cancelled` - Workflow was manually cancelled by user

**WorkflowExecutionStepStatus**
- `pending` - Step has not started yet
- `running` - Step is currently executing
- `completed` - Step finished successfully
- `failed` - Step encountered an error
- `skipped` - Step was skipped based on conditional logic

### 2. Tables

#### workflow_templates
Blueprint definitions for reusable workflows.

**Columns:**
- `id` - CUID2 primary key
- `name` - Human-readable workflow name (required)
- `description` - Detailed description of what the workflow does
- `driveId` - FK to drives (CASCADE) - workflows are scoped to drives
- `createdBy` - FK to users (CASCADE) - original creator
- `category` - Optional categorization (e.g., "data-analysis", "content-generation")
- `tags` - PostgreSQL text array for search/filtering
- `isPublic` - Whether template can be discovered by other drive members
- `createdAt`, `updatedAt` - Standard timestamps

**Indexes:**
- `driveId` - For listing workflows in a drive
- `createdBy` - For user's workflow library
- `isPublic` - For filtering public vs private templates
- `category` - For category-based filtering

**Design Rationale:**
- Templates are scoped to drives to respect workspace boundaries
- `isPublic` flag allows sharing within drive while keeping private workflows hidden
- Tags array enables flexible categorization without additional tables
- CASCADE delete on driveId/createdBy - if drive or user is deleted, their workflows go too

#### workflow_steps
Individual steps within a workflow template, executed in sequence.

**Columns:**
- `id` - CUID2 primary key
- `workflowTemplateId` - FK to workflow_templates (CASCADE)
- `stepOrder` - Integer defining execution sequence (0-based)
- `agentId` - Identifier for which AI agent to use (e.g., "code-reviewer", "documentation-writer")
- `promptTemplate` - Template string with variable substitution syntax
- `requiresUserInput` - Boolean indicating if step should pause for user input
- `inputSchema` - JSONB schema defining expected user input format
- `metadata` - JSONB for additional configuration (timeout, retry logic, etc.)
- `createdAt`, `updatedAt` - Standard timestamps

**Indexes:**
- `workflowTemplateId` - For loading all steps of a template
- `(workflowTemplateId, stepOrder)` - Composite index for ordered retrieval

**Design Rationale:**
- `stepOrder` enables flexible step sequencing without gaps
- CASCADE delete on workflowTemplateId - steps are meaningless without their template
- JSONB `inputSchema` provides flexibility for various input types
- JSONB `metadata` allows extensibility without schema changes

#### workflow_executions
Running instances of workflow templates, tracking execution state.

**Columns:**
- `id` - CUID2 primary key
- `workflowTemplateId` - FK to workflow_templates (CASCADE)
- `userId` - FK to users (CASCADE) - who initiated the execution
- `driveId` - FK to drives (CASCADE) - execution context
- `status` - Enum tracking execution state
- `currentStepOrder` - Integer indicating current step (nullable if not started)
- `accumulatedContext` - JSONB storing all context built up across steps
- `startedAt`, `pausedAt`, `completedAt`, `failedAt` - State transition timestamps
- `errorMessage` - Text description of failure reason
- `createdAt`, `updatedAt` - Standard timestamps

**Indexes:**
- `workflowTemplateId` - For template usage analytics
- `userId` - For user's execution history
- `driveId` - For drive-wide execution monitoring
- `status` - For filtering by execution state
- `(userId, status)` - Composite for user's active workflows
- `(driveId, status)` - Composite for drive's active workflows

**Design Rationale:**
- Separate timestamps for each state transition enable detailed analytics
- `accumulatedContext` stores all data passed between steps (inputs, outputs, variables)
- CASCADE delete on all FKs - executions are dependent on their context
- Multiple composite indexes optimize common query patterns

#### workflow_execution_steps
Records of individual step executions within a workflow run.

**Columns:**
- `id` - CUID2 primary key
- `workflowExecutionId` - FK to workflow_executions (CASCADE)
- `workflowStepId` - FK to workflow_steps (SET NULL) - nullable for audit trail
- `stepOrder` - Integer matching the step order in template
- `status` - Enum tracking step execution state
- `agentInput` - JSONB of what was sent to the agent
- `agentOutput` - JSONB of agent's response
- `userInput` - JSONB of user input if step required it
- `startedAt`, `completedAt` - Execution timing
- `errorMessage` - Text description of step failure
- `createdAt`, `updatedAt` - Standard timestamps

**Indexes:**
- `workflowExecutionId` - For loading execution history
- `workflowStepId` - For step performance analytics
- `status` - For filtering by step state
- `(workflowExecutionId, stepOrder)` - Composite for ordered retrieval

**Design Rationale:**
- SET NULL on workflowStepId preserves execution history if step definition is deleted
- CASCADE delete on workflowExecutionId - step records are meaningless without execution
- Separate JSONB fields for inputs/outputs enable detailed debugging and analytics
- `stepOrder` duplicated from definition for fast querying without joins

## Permissions Model

Workflows respect PageSpace's drive-based permission system:

**Template Creation:**
- Users can create templates in drives where they have `write` or higher access
- Template creator is recorded in `createdBy` field

**Template Visibility:**
- `isPublic = true` templates are visible to all drive members
- `isPublic = false` templates are only visible to creator and admins

**Template Execution:**
- Users can execute templates in drives where they have `read` or higher access
- Execution creates records linked to both user and drive

**Implementation:**
```typescript
// Check if user can create workflow in drive
const accessLevel = await getUserAccessLevel(userId, driveId);
if (accessLevel < AccessLevel.WRITE) {
  throw new Error('Insufficient permissions to create workflow');
}

// Check if user can execute workflow
const template = await db.query.workflowTemplates.findFirst({
  where: eq(workflowTemplates.id, templateId),
});
const canExecute = await canUserAccessDrive(userId, template.driveId);
if (!canExecute) {
  throw new Error('Insufficient permissions to execute workflow');
}
```

## Foreign Key Cascade Rules

**CASCADE Deletes:**
- `workflow_steps.workflowTemplateId` → CASCADE (steps deleted with template)
- `workflow_executions.workflowTemplateId` → CASCADE (executions deleted with template)
- `workflow_executions.userId` → CASCADE (executions deleted with user)
- `workflow_executions.driveId` → CASCADE (executions deleted with drive)
- `workflow_execution_steps.workflowExecutionId` → CASCADE (step records deleted with execution)
- `workflow_templates.driveId` → CASCADE (templates deleted with drive)
- `workflow_templates.createdBy` → CASCADE (templates deleted with user)

**SET NULL:**
- `workflow_execution_steps.workflowStepId` → SET NULL (preserve execution history)

## Usage Examples

### Creating a Workflow Template

```typescript
import { db, workflowTemplates, workflowSteps } from '@pagespace/db';
import { createId } from '@paralleldrive/cuid2';

// Create template
const [template] = await db.insert(workflowTemplates).values({
  name: 'Code Review Workflow',
  description: 'Automated code review with security analysis',
  driveId: 'drive_xyz',
  createdBy: 'user_abc',
  category: 'code-review',
  tags: ['security', 'quality', 'automated'],
  isPublic: true,
}).returning();

// Add steps
await db.insert(workflowSteps).values([
  {
    workflowTemplateId: template.id,
    stepOrder: 0,
    agentId: 'code-reviewer',
    promptTemplate: 'Review the following code for bugs and improvements: {{code}}',
    requiresUserInput: false,
  },
  {
    workflowTemplateId: template.id,
    stepOrder: 1,
    agentId: 'security-analyst',
    promptTemplate: 'Analyze security vulnerabilities in: {{code}}. Previous review: {{step_0_output}}',
    requiresUserInput: false,
  },
  {
    workflowTemplateId: template.id,
    stepOrder: 2,
    agentId: 'documentation-writer',
    promptTemplate: 'Generate documentation based on review: {{step_0_output}} and security analysis: {{step_1_output}}',
    requiresUserInput: true,
    inputSchema: {
      type: 'object',
      properties: {
        includeExamples: { type: 'boolean' },
        detailLevel: { type: 'string', enum: ['basic', 'detailed', 'comprehensive'] }
      }
    },
  },
]);
```

### Starting a Workflow Execution

```typescript
import { db, workflowExecutions } from '@pagespace/db';

const [execution] = await db.insert(workflowExecutions).values({
  workflowTemplateId: 'template_xyz',
  userId: 'user_abc',
  driveId: 'drive_xyz',
  status: 'running',
  currentStepOrder: 0,
  accumulatedContext: {
    code: 'function hello() { console.log("world"); }',
  },
  startedAt: new Date(),
}).returning();
```

### Recording Step Execution

```typescript
import { db, workflowExecutionSteps } from '@pagespace/db';

// Record step start
const [step] = await db.insert(workflowExecutionSteps).values({
  workflowExecutionId: execution.id,
  workflowStepId: 'step_xyz',
  stepOrder: 0,
  status: 'running',
  agentInput: {
    prompt: 'Review the following code...',
    context: execution.accumulatedContext,
  },
  startedAt: new Date(),
}).returning();

// Update with completion
await db.update(workflowExecutionSteps)
  .set({
    status: 'completed',
    agentOutput: {
      review: 'Code looks good, but consider error handling...',
      suggestions: ['Add try-catch', 'Validate inputs'],
    },
    completedAt: new Date(),
  })
  .where(eq(workflowExecutionSteps.id, step.id));

// Update execution context with step output
await db.update(workflowExecutions)
  .set({
    accumulatedContext: {
      ...execution.accumulatedContext,
      step_0_output: step.agentOutput,
    },
    currentStepOrder: 1,
  })
  .where(eq(workflowExecutions.id, execution.id));
```

### Querying Workflows

```typescript
import { db, eq, and } from '@pagespace/db';

// Get all templates in a drive
const templates = await db.query.workflowTemplates.findMany({
  where: eq(workflowTemplates.driveId, driveId),
  with: {
    steps: true,
    creator: {
      columns: { id: true, name: true, email: true },
    },
  },
  orderBy: [desc(workflowTemplates.createdAt)],
});

// Get user's running executions
const runningExecutions = await db.query.workflowExecutions.findMany({
  where: and(
    eq(workflowExecutions.userId, userId),
    eq(workflowExecutions.status, 'running')
  ),
  with: {
    template: true,
    steps: {
      orderBy: [asc(workflowExecutionSteps.stepOrder)],
    },
  },
});

// Get execution details with full history
const execution = await db.query.workflowExecutions.findFirst({
  where: eq(workflowExecutions.id, executionId),
  with: {
    template: {
      with: { steps: true },
    },
    steps: {
      orderBy: [asc(workflowExecutionSteps.stepOrder)],
      with: {
        stepDefinition: true,
      },
    },
  },
});
```

## Migration

The schema has been implemented in migration `0006_first_barracuda.sql`.

To apply the migration:

```bash
pnpm db:migrate
```

This will create:
- 2 enum types: `WorkflowExecutionStatus`, `WorkflowExecutionStepStatus`
- 4 tables: `workflow_templates`, `workflow_steps`, `workflow_executions`, `workflow_execution_steps`
- 8 foreign key constraints with appropriate cascade rules
- 16 indexes optimized for common query patterns

## Performance Considerations

**Indexes:**
- All foreign keys are indexed for join performance
- Composite indexes on `(parentId, order)` patterns optimize ordered retrieval
- Status indexes enable fast filtering of active/completed workflows

**JSONB Usage:**
- `accumulatedContext` can grow large for long workflows - consider pagination for display
- `agentInput`/`agentOutput` enable detailed debugging but increase storage
- Consider archiving completed executions older than 90 days

**Query Optimization:**
- Use `with` relations to avoid N+1 queries
- Select only needed columns for large result sets
- Use pagination for execution history listings

## Future Enhancements

Potential schema additions for future features:

1. **Workflow Versioning**: Add `version` field and `parentTemplateId` for template evolution
2. **Conditional Branching**: Add `conditions` JSONB to steps for dynamic routing
3. **Parallel Execution**: Add `parallelGroup` field to enable concurrent step execution
4. **Scheduled Workflows**: Add `workflow_schedules` table for recurring executions
5. **Workflow Analytics**: Add aggregated metrics table for performance tracking
6. **Step Retry Logic**: Extend `metadata` to include retry configuration
7. **Human-in-the-Loop**: Extend user input to support approval workflows

## Related Documentation

- [Permissions & Authorization System](/docs/2.0-architecture/permissions.md)
- [AI System Architecture](/docs/2.0-architecture/ai-system.md)
- [Database Schema Overview](/docs/2.0-architecture/database.md)
- [Drizzle ORM Best Practices](/docs/3.0-guides-and-tools/database-guide.md)
