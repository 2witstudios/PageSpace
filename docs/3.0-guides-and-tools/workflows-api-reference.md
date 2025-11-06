# Workflows API Reference

## Overview

This document describes the REST API endpoints for the PageSpace Workflows system. All endpoints require authentication via JWT token.

## Table of Contents

1. [Workflow Templates](#workflow-templates)
2. [Workflow Executions](#workflow-executions)
3. [Data Models](#data-models)
4. [Error Responses](#error-responses)

## Workflow Templates

### List Workflow Templates

List all workflow templates accessible to the authenticated user.

```http
GET /api/workflows/templates
```

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `driveId` | string | No | Filter by specific drive ID |
| `category` | string | No | Filter by category |
| `tags` | string | No | Comma-separated list of tags to filter |

**Response:** `200 OK`

```json
{
  "templates": [
    {
      "id": "cuid_abc123",
      "name": "Blog Post Creation",
      "description": "Multi-step blog post creation workflow",
      "driveId": "drive_xyz",
      "category": "Content Generation",
      "tags": ["writing", "content", "blog"],
      "isPublic": true,
      "stepCount": 5,
      "createdBy": "user_123",
      "createdAt": "2025-11-06T10:00:00Z",
      "updatedAt": "2025-11-06T10:00:00Z"
    }
  ]
}
```

### Get Workflow Template

Get a single workflow template with all steps.

```http
GET /api/workflows/templates/:templateId
```

**Response:** `200 OK`

```json
{
  "id": "cuid_abc123",
  "name": "Blog Post Creation",
  "description": "Multi-step blog post creation workflow",
  "driveId": "drive_xyz",
  "category": "Content Generation",
  "tags": ["writing", "content", "blog"],
  "isPublic": true,
  "createdBy": "user_123",
  "createdAt": "2025-11-06T10:00:00Z",
  "updatedAt": "2025-11-06T10:00:00Z",
  "steps": [
    {
      "id": "step_001",
      "stepOrder": 0,
      "agentId": "agent_research",
      "promptTemplate": "Research the topic: {{initialContext.topic}}",
      "requiresUserInput": false,
      "inputSchema": null,
      "metadata": {}
    },
    {
      "id": "step_002",
      "stepOrder": 1,
      "agentId": "agent_writer",
      "promptTemplate": "Write a blog post about {{initialContext.topic}} based on: {{step0.output}}",
      "requiresUserInput": false,
      "inputSchema": null,
      "metadata": {}
    }
  ]
}
```

**Error Responses:**
- `404 Not Found`: Template doesn't exist
- `403 Forbidden`: No access to template's drive

### Create Workflow Template

Create a new workflow template.

```http
POST /api/workflows/templates
```

**Request Body:**

```json
{
  "name": "Blog Post Creation",
  "description": "Multi-step blog post creation workflow",
  "driveId": "drive_xyz",
  "category": "Content Generation",
  "tags": ["writing", "content", "blog"],
  "isPublic": false,
  "steps": [
    {
      "agentId": "agent_research",
      "promptTemplate": "Research {{initialContext.topic}}",
      "requiresUserInput": false,
      "inputSchema": null,
      "metadata": {}
    }
  ]
}
```

**Validation Rules:**
- `name`: Required, 1-255 characters
- `driveId`: Required, must be accessible to user
- `steps`: Required, array with at least 1 step
- `steps[].agentId`: Required, must be valid AI_CHAT page ID
- `steps[].promptTemplate`: Required, non-empty string
- `steps[].stepOrder`: Auto-assigned based on array order

**Response:** `201 Created`

```json
{
  "id": "cuid_abc123",
  "name": "Blog Post Creation",
  // ... full template with steps
}
```

**Error Responses:**
- `400 Bad Request`: Validation error
- `403 Forbidden`: No write access to drive
- `404 Not Found`: Agent ID doesn't exist

### Update Workflow Template

Update an existing workflow template.

```http
PATCH /api/workflows/templates/:templateId
```

**Request Body:** (All fields optional)

```json
{
  "name": "Updated Blog Post Creation",
  "description": "Updated description",
  "category": "Content",
  "tags": ["writing", "blog"],
  "isPublic": true,
  "steps": [
    // If provided, replaces ALL steps
  ]
}
```

**Response:** `200 OK`

```json
{
  "id": "cuid_abc123",
  // ... updated template
}
```

**Error Responses:**
- `400 Bad Request`: Validation error
- `403 Forbidden`: No write access to drive
- `404 Not Found`: Template doesn't exist

### Delete Workflow Template

Delete a workflow template.

```http
DELETE /api/workflows/templates/:templateId
```

**Response:** `200 OK`

```json
{
  "success": true,
  "message": "Workflow template deleted successfully"
}
```

**Error Responses:**
- `403 Forbidden`: No write access to drive
- `404 Not Found`: Template doesn't exist
- `409 Conflict`: Active executions exist for this template

## Workflow Executions

### List Workflow Executions

List workflow executions for the authenticated user.

```http
GET /api/workflows/executions
```

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `driveId` | string | No | Filter by drive ID |
| `status` | string | No | Filter by status (running, paused, completed, failed, cancelled) |
| `limit` | number | No | Limit results (default: 50, max: 100) |

**Response:** `200 OK`

```json
{
  "executions": [
    {
      "id": "exec_001",
      "workflowTemplateId": "template_001",
      "templateName": "Blog Post Creation",
      "status": "completed",
      "currentStepOrder": 4,
      "totalSteps": 5,
      "progressPercentage": 100,
      "startedAt": "2025-11-06T10:00:00Z",
      "completedAt": "2025-11-06T10:15:00Z"
    }
  ]
}
```

### Get Workflow Execution

Get detailed execution state with all steps.

```http
GET /api/workflows/executions/:executionId
```

**Response:** `200 OK`

```json
{
  "id": "exec_001",
  "workflowTemplateId": "template_001",
  "userId": "user_123",
  "driveId": "drive_xyz",
  "status": "running",
  "currentStepOrder": 2,
  "accumulatedContext": {
    "initialContext": { "topic": "AI Workflows" },
    "step0Output": "Research results...",
    "step1Output": "Draft content..."
  },
  "startedAt": "2025-11-06T10:00:00Z",
  "pausedAt": null,
  "completedAt": null,
  "failedAt": null,
  "errorMessage": null,
  "template": {
    "id": "template_001",
    "name": "Blog Post Creation",
    "totalSteps": 5
  },
  "steps": [
    {
      "id": "execstep_001",
      "stepOrder": 0,
      "status": "completed",
      "agentInput": { "prompt": "Research AI Workflows" },
      "agentOutput": { "content": "Research results..." },
      "userInput": null,
      "startedAt": "2025-11-06T10:00:00Z",
      "completedAt": "2025-11-06T10:05:00Z"
    },
    {
      "id": "execstep_002",
      "stepOrder": 1,
      "status": "completed",
      "agentInput": { "prompt": "Write blog post..." },
      "agentOutput": { "content": "Draft content..." },
      "userInput": null,
      "startedAt": "2025-11-06T10:05:00Z",
      "completedAt": "2025-11-06T10:10:00Z"
    },
    {
      "id": "execstep_003",
      "stepOrder": 2,
      "status": "running",
      "agentInput": { "prompt": "Edit content..." },
      "agentOutput": null,
      "userInput": null,
      "startedAt": "2025-11-06T10:10:00Z",
      "completedAt": null
    }
  ],
  "progressPercentage": 40
}
```

**Error Responses:**
- `403 Forbidden`: Not the execution owner
- `404 Not Found`: Execution doesn't exist

### Start Workflow Execution

Create and start a new workflow execution.

```http
POST /api/workflows/executions
```

**Request Body:**

```json
{
  "templateId": "template_001",
  "initialContext": {
    "topic": "AI Workflows",
    "audience": "developers"
  }
}
```

**Response:** `201 Created`

```json
{
  "id": "exec_001",
  "status": "running",
  "currentStepOrder": 0,
  // ... full execution state
}
```

**Error Responses:**
- `400 Bad Request`: Invalid template ID
- `403 Forbidden`: No access to template
- `404 Not Found`: Template doesn't exist

### Execute Next Step

Execute the next step in the workflow.

```http
POST /api/workflows/executions/:executionId/next
```

**Response:** `200 OK`

```json
{
  "success": true,
  "execution": {
    // ... updated execution state
  },
  "metadata": {
    "completed": false,
    "requiresUserInput": true
  }
}
```

**Error Responses:**
- `400 Bad Request`: Cannot execute (wrong status, no more steps, etc.)
- `403 Forbidden`: Not the execution owner
- `404 Not Found`: Execution doesn't exist

### Submit User Input

Submit user input for the current step and continue execution.

```http
POST /api/workflows/executions/:executionId/input
```

**Request Body:**

```json
{
  "userInput": {
    "field1": "value1",
    "field2": "value2"
  }
}
```

**Response:** `200 OK`

```json
{
  "success": true,
  "execution": {
    // ... updated execution state after executing step with input
  }
}
```

**Error Responses:**
- `400 Bad Request`: Current step doesn't require input or validation failed
- `403 Forbidden`: Not the execution owner
- `404 Not Found`: Execution doesn't exist

### Pause Workflow Execution

Pause a running workflow.

```http
POST /api/workflows/executions/:executionId/pause
```

**Response:** `200 OK`

```json
{
  "success": true,
  "execution": {
    "id": "exec_001",
    "status": "paused",
    "pausedAt": "2025-11-06T10:15:00Z"
  }
}
```

**Error Responses:**
- `400 Bad Request`: Cannot pause (not running)
- `403 Forbidden`: Not the execution owner
- `404 Not Found`: Execution doesn't exist

### Resume Workflow Execution

Resume a paused workflow.

```http
POST /api/workflows/executions/:executionId/resume
```

**Response:** `200 OK`

```json
{
  "success": true,
  "execution": {
    "id": "exec_001",
    "status": "running",
    "pausedAt": null
  }
}
```

**Error Responses:**
- `400 Bad Request`: Cannot resume (not paused)
- `403 Forbidden`: Not the execution owner
- `404 Not Found`: Execution doesn't exist

### Cancel Workflow Execution

Cancel a running or paused workflow.

```http
POST /api/workflows/executions/:executionId/cancel
```

**Response:** `200 OK`

```json
{
  "success": true,
  "execution": {
    "id": "exec_001",
    "status": "cancelled"
  }
}
```

**Error Responses:**
- `400 Bad Request`: Already completed/failed/cancelled
- `403 Forbidden`: Not the execution owner
- `404 Not Found`: Execution doesn't exist

## Helper Endpoints

### List Available Agents

Get all AI_CHAT pages accessible to the user.

```http
GET /api/workflows/agents
```

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `driveId` | string | No | Filter by specific drive ID |

**Response:** `200 OK`

```json
{
  "agents": [
    {
      "id": "agent_001",
      "title": "Research Agent",
      "driveId": "drive_xyz"
    }
  ]
}
```

## Data Models

### WorkflowTemplate

```typescript
{
  id: string;                    // CUID
  name: string;                  // Template name
  description: string | null;    // Optional description
  driveId: string;               // Drive ID
  createdBy: string;             // User ID
  category: string | null;       // Category name
  tags: string[];                // Array of tags
  isPublic: boolean;             // Public visibility
  createdAt: string;             // ISO 8601 timestamp
  updatedAt: string;             // ISO 8601 timestamp
  steps?: WorkflowStep[];        // Steps (when expanded)
  stepCount?: number;            // Step count (in list view)
}
```

### WorkflowStep

```typescript
{
  id: string;                           // CUID
  workflowTemplateId: string;           // Parent template ID
  stepOrder: number;                    // Order in sequence (0-based)
  agentId: string;                      // AI_CHAT page ID
  promptTemplate: string;               // Prompt with variables
  requiresUserInput: boolean;           // Requires user input
  inputSchema: Record<string, any> | null;  // JSON schema for input
  metadata: Record<string, any> | null; // Additional metadata
}
```

### WorkflowExecution

```typescript
{
  id: string;                           // CUID
  workflowTemplateId: string;           // Template ID
  userId: string;                       // Executing user ID
  driveId: string;                      // Drive ID
  status: 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  currentStepOrder: number;             // Current step index
  accumulatedContext: Record<string, any>; // All collected data
  startedAt: string;                    // ISO 8601 timestamp
  pausedAt: string | null;              // ISO 8601 timestamp
  completedAt: string | null;           // ISO 8601 timestamp
  failedAt: string | null;              // ISO 8601 timestamp
  errorMessage: string | null;          // Error details if failed
  steps?: WorkflowExecutionStep[];      // Step records (when expanded)
  template?: {                          // Template info (when expanded)
    id: string;
    name: string;
    totalSteps: number;
  };
  progressPercentage?: number;          // Calculated progress (0-100)
}
```

### WorkflowExecutionStep

```typescript
{
  id: string;                           // CUID
  workflowExecutionId: string;          // Parent execution ID
  workflowStepId: string | null;        // Step definition ID
  stepOrder: number;                    // Step index
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  agentInput: Record<string, any> | null;  // Input sent to agent
  agentOutput: Record<string, any> | null; // Agent response
  userInput: Record<string, any> | null;   // User input
  startedAt: string | null;             // ISO 8601 timestamp
  completedAt: string | null;           // ISO 8601 timestamp
  errorMessage: string | null;          // Error details if failed
}
```

## Error Responses

All error responses follow this format:

```json
{
  "error": "Error message describing what went wrong"
}
```

### HTTP Status Codes

| Code | Meaning | Common Causes |
|------|---------|---------------|
| `400` | Bad Request | Invalid input, validation error, cannot perform action |
| `401` | Unauthorized | Missing or invalid authentication token |
| `403` | Forbidden | No permission to access resource |
| `404` | Not Found | Resource doesn't exist |
| `409` | Conflict | Cannot delete due to active executions |
| `500` | Internal Server Error | Server-side error |

## Rate Limiting

Currently, no rate limiting is enforced, but it may be added in the future. Best practices:
- Don't poll execution status more than once per second
- Use the auto-refresh feature in the UI instead of manual polling
- Batch template operations when possible

## Authentication

All endpoints require authentication. Include the JWT token in the Authorization header:

```http
Authorization: Bearer <your-jwt-token>
```

Or use MCP token authentication for external integrations:

```http
Authorization: Bearer <mcp-token>
```

## Pagination

Currently, list endpoints don't support pagination beyond the `limit` parameter. This may be added in the future if needed.
