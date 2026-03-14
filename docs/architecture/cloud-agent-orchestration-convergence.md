# Cloud Agent Orchestration: PageSpace + PurePoint + AIDD Convergence

## Executive Summary

This document outlines the architectural convergence of three systems into a unified cloud-based agent orchestration platform:

| System | Current Role | Convergence Role |
|--------|-------------|------------------|
| **PageSpace** | Collaborative workspace with AI, real-time, multi-tenant | **Coordination Layer** - The "Point Guard" |
| **PurePoint** | Local worktree-based parallel agent orchestration | **Agent Lifecycle Manager** - Cloud containers instead of worktrees |
| **AIDD** | AI-Driven Development framework with commands/rules | **Workflow Engine** - Task epics, TDD, review workflows |
| **opencode-sdk** | Container-isolated agent execution | **Execution Runtime** - Isolated agent environments |

## Problem Statement (from Eric)

> "How hard would it be to move this to the cloud and have them use Git, GitHub, the repos /task epics, and Slack for coordination? By slack, I mean we should be able to observe their thinking and send them messages, steer them from chat, etc."

> "I always think these things designed to work on one person's Mac are made by solo devs, not teams. Keep in mind our main customers are 3-20 human teams working on large software projects."

## Key Requirements

1. **Cloud-Native**: Replace local worktrees with cloud containers
2. **Team Coordination**: Git/GitHub + Slack integration
3. **Agent Observation**: Real-time visibility into agent thinking
4. **Agent Steering**: Human-in-the-loop intervention via chat
5. **AIDD Integration**: Task epics, TDD workflows, review commands
6. **Multi-Tenant**: 3-20 person teams on large projects

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              PAGESPACE CLOUD                                 │
│                         (Coordination Layer)                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │
│  │   Slack     │  │   GitHub    │  │   Web UI    │  │   API       │        │
│  │ Integration │  │ Integration │  │   (React)   │  │   Routes    │        │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘        │
│         │                │                │                │                │
│         └────────────────┴────────────────┴────────────────┘                │
│                                   │                                          │
│                        ┌──────────▼──────────┐                               │
│                        │   Coordination      │                               │
│                        │   Engine            │                               │
│                        │   (Socket.IO +      │                               │
│                        │    PostgreSQL)      │                               │
│                        └──────────┬──────────┘                               │
│                                   │                                          │
├───────────────────────────────────┼──────────────────────────────────────────┤
│                        ┌──────────▼──────────┐                               │
│                        │   AIDD Workflow     │                               │
│                        │   Engine            │                               │
│                        │   - /task epics     │                               │
│                        │   - /plan           │                               │
│                        │   - /review         │                               │
│                        │   - /execute        │                               │
│                        └──────────┬──────────┘                               │
│                                   │                                          │
├───────────────────────────────────┼──────────────────────────────────────────┤
│                        ┌──────────▼──────────┐                               │
│                        │   Agent Lifecycle   │                               │
│                        │   Manager           │                               │
│                        │   (PurePoint Core)  │                               │
│                        └──────────┬──────────┘                               │
│                                   │                                          │
├───────────────────────────────────┼──────────────────────────────────────────┤
│              CONTAINER ORCHESTRATION LAYER (Kubernetes/Docker)              │
│                                   │                                          │
│    ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│    │  Container 1 │  │  Container 2 │  │  Container 3 │  │  Container N │  │
│    │  Claude Code │  │  Claude Code │  │  Claude Code │  │  Claude Code │  │
│    │  + repo/     │  │  + repo/     │  │  + repo/     │  │  + repo/     │  │
│    │  + git br    │  │  + git br    │  │  + git br    │  │  + git br    │  │
│    └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘  │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Component Deep Dive

### 1. Coordination Engine (PageSpace Core)

**Existing Infrastructure to Leverage:**

| Component | Location | Purpose |
|-----------|----------|---------|
| Socket.IO | `apps/realtime/` | Real-time agent observation |
| Drives | `packages/db/src/schema/core.ts` | Multi-tenant workspace isolation |
| Conversations | `packages/db/src/schema/conversations.ts` | Agent conversation tracking |
| GitHub Integration | `packages/lib/src/integrations/providers/github.ts` | Repo/PR/Issue operations |
| Agent Communication | `apps/web/src/lib/ai/tools/agent-communication-tools.ts` | ask_agent tool |
| Task Assignment | `packages/db/src/schema/tasks.ts` | `agentPageId` for agent tasks |

**New Components Needed:**

```typescript
// New database schema for agent containers
interface AgentContainer {
  id: string;
  driveId: string;           // Workspace isolation
  name: string;
  status: 'pending' | 'running' | 'paused' | 'completed' | 'failed';
  containerId: string;       // Docker/K8s container ID
  branch: string;            // Git branch
  baseBranch: string;        // Base branch for PR
  repository: string;        // GitHub repo (owner/name)
  agentType: 'claude' | 'codex' | 'opencode';
  prompt: string;            // Current task prompt
  thinking: string;          // Real-time thinking stream
  startedAt: Date;
  completedAt?: Date;
  createdBy: string;         // User who spawned agent
  assignedUsers: string[];   // Users observing/steering
}

// Agent steering messages
interface AgentSteeringMessage {
  id: string;
  containerId: string;
  fromUserId: string;
  message: string;
  timestamp: Date;
  read: boolean;
}
```

### 2. AIDD Workflow Engine

**AIDD Commands → PageSpace Skills Mapping:**

| AIDD Command | PageSpace Skill | Implementation |
|--------------|-----------------|----------------|
| `/task` | `task` skill | Create task epic from requirements |
| `/plan` | `plan` skill | Review plan.md, suggest priorities |
| `/review` | `review` skill | Code review with rubric |
| `/execute` | `execute` skill | Execute task/epic |
| `/commit` | `commit` skill | Conventional commits |
| `/discover` | `discover` skill | Explore codebase |
| `/log` | `log` skill | Document changes |

**AIDD Rules Integration:**

```typescript
// AIDD rules stored as drive-level configuration
interface AIDDConfig {
  driveId: string;
  rules: {
    tdd: boolean;              // Enforce TDD
    reviewRequired: boolean;   // Require /review before commit
    commitConvention: string;  // Conventional commits format
    maxFileComplexity: number; // Cyclomatic complexity limit
  };
  commands: {
    [key: string]: {
      enabled: boolean;
      customPrompt?: string;
    };
  };
}
```

### 3. Agent Lifecycle Manager (PurePoint Evolution)

**Current PurePoint (`.pu/manifest.json`):**
```json
{
  "worktrees": {
    "wt-ytivxrsp": {
      "id": "wt-ytivxrsp",
      "name": "ai-chat-system",
      "path": "/Users/jono/production/PageSpace/.pu/worktrees/wt-ytivxrsp",
      "branch": "pu/ai-chat-system",
      "baseBranch": "master",
      "status": "active",
      "agents": {
        "ag-r7h65xnu": {
          "id": "ag-r7h65xnu",
          "agentType": "claude",
          "status": "streaming",
          "prompt": "...",
          "pid": 34215,
          "sessionId": "..."
        }
      }
    }
  }
}
```

**Cloud-Evolved Schema:**

```json
{
  "containers": {
    "cnt-ytivxrsp": {
      "id": "cnt-ytivxrsp",
      "name": "ai-chat-system",
      "containerId": "docker://abc123...",
      "podId": "k8s://pagespace-agent-ai-chat-system-xyz",
      "repository": "2witstudios/PageSpace",
      "branch": "pu/ai-chat-system",
      "baseBranch": "master",
      "status": "running",
      "agent": {
        "id": "ag-r7h65xnu",
        "type": "claude",
        "status": "streaming",
        "model": "claude-sonnet-4-6",
        "prompt": "...",
        "thinking": "I'm analyzing the component structure...",
        "tokenUsage": { "input": 15000, "output": 3000 },
        "files": ["apps/web/src/components/ai/..."]
      },
      "git": {
        "hasUncommittedChanges": true,
        "commitsAhead": 3,
        "pullRequestUrl": null
      },
      "steeringMessages": [],
      "createdAt": "2026-03-10T19:21:39.495844Z",
      "createdBy": "user-123",
      "observers": ["user-123", "user-456"]
    }
  }
}
```

### 4. Container Orchestration Layer

**Options:**

| Platform | Pros | Cons |
|----------|------|------|
| **Docker Compose** | Simple, PageSpace already uses | Not production-scalable |
| **Kubernetes** | Industry standard, scalable | Complex setup |
| **ECS/Fargate** | AWS-native, serverless | AWS lock-in |
| **Fly.io** | Simple deploy, global edge | Less control |
| **E2B** | Purpose-built for code execution | Limited to code sandbox |

**Recommended: Kubernetes with Helm Charts**

```yaml
# helm/agent-container/templates/agent-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: pagespace-agent-{{ .Values.agentId }}
spec:
  replicas: 1
  template:
    spec:
      containers:
      - name: claude-code
        image: anthropic/claude-code:latest
        env:
        - name: AGENT_ID
          value: {{ .Values.agentId }}
        - name: REPOSITORY_URL
          value: {{ .Values.repositoryUrl }}
        - name: BRANCH
          value: {{ .Values.branch }}
        volumeMounts:
        - name: repo
          mountPath: /workspace
        resources:
          limits:
            memory: "4Gi"
            cpu: "2"
      volumes:
      - name: repo
        persistentVolumeClaim:
          claimName: repo-{{ .Values.agentId }}
```

---

## Slack Integration Architecture

### Bidirectional Communication

```
┌─────────────┐                    ┌─────────────────┐
│   Slack     │                    │    PageSpace    │
│   Workspace │                    │    Cloud        │
├─────────────┤                    ├─────────────────┤
│             │   Webhook Events   │                 │
│  #aidd-bot  │◄───────────────────│  Agent Events   │
│             │   (thinking, done) │                 │
│             │                    │                 │
│  User Msg   │───────────────────►│  Steering       │
│  "steer..." │   Slack API        │  Processor      │
│             │                    │                 │
└─────────────┘                    └─────────────────┘
```

### Slack Bot Commands

| Command | Purpose |
|---------|---------|
| `/aidd spawn <task>` | Create new agent container |
| `/aidd list` | List running agents |
| `/aidd observe <agent>` | Subscribe to agent thinking |
| `/aidd steer <agent> <msg>` | Send steering message |
| `/aidd pause <agent>` | Pause agent |
| `/aidd resume <agent>` | Resume agent |
| `/aidd review <agent>` | Request review of agent work |
| `/aidd merge <agent>` | Merge agent branch to base |

### Agent Thinking to Slack

```typescript
// Real-time thinking stream to Slack
async function streamThinkingToSlack(containerId: string, channelId: string) {
  const container = await getContainer(containerId);

  // Stream thinking updates to Slack thread
  container.on('thinking', async (chunk) => {
    await slackClient.chat.postMessage({
      channel: channelId,
      thread_ts: container.threadTs,
      text: `🤔 ${chunk}`,
      mrkdwn: false
    });
  });

  container.on('tool_use', async (tool) => {
    await slackClient.chat.postMessage({
      channel: channelId,
      thread_ts: container.threadTs,
      text: `🔧 Using tool: ${tool.name}`,
      blocks: [
        {
          type: "context",
          elements: [{ type: "mrkdwn", text: `*Input:* ${JSON.stringify(tool.input)}` }]
        }
      ]
    });
  });

  container.on('complete', async (result) => {
    await slackClient.chat.postMessage({
      channel: channelId,
      thread_ts: container.threadTs,
      text: `✅ Agent completed: ${result.summary}`,
      attachments: [
        {
          color: "good",
          fields: [
            { title: "Files Changed", value: result.filesChanged.join("\n"), short: true },
            { title: "Branch", value: container.branch, short: true }
          ],
          actions: [
            { type: "button", text: "Review PR", url: result.prUrl },
            { type: "button", text: "View in PageSpace", url: container.pageSpaceUrl }
          ]
        }
      ]
    });
  });
}
```

---

## Human-in-the-Loop Steering

### Steering Protocol

```typescript
interface SteeringProtocol {
  // User sends steering message
  async steer(containerId: string, message: string): Promise<void> {
    // 1. Store steering message in database
    await db.insert(steeringMessages).values({
      containerId,
      fromUserId: currentUser.id,
      message,
      timestamp: new Date()
    });

    // 2. Emit to container via WebSocket
    io.to(`container:${containerId}`).emit('steering', {
      message,
      from: currentUser.name,
      timestamp: new Date()
    });

    // 3. If agent is waiting for input, resume
    const container = await getContainer(containerId);
    if (container.status === 'waiting_for_input') {
      await resumeAgent(containerId, message);
    }
  }

  // Agent requests human input
  async requestInput(containerId: string, prompt: string): Promise<string> {
    // 1. Update container status
    await updateContainer(containerId, { status: 'waiting_for_input' });

    // 2. Notify observers via Slack and PageSpace
    await notifyObservers(containerId, {
      type: 'input_required',
      prompt,
      containerId
    });

    // 3. Wait for steering message
    return new Promise((resolve) => {
      const handler = (msg: SteeringMessage) => {
        if (msg.containerId === containerId) {
          unsubscribe();
          resolve(msg.message);
        }
      };
      subscribe('steering', handler);
    });
  }
}
```

### Requirement Update Detection

```typescript
// Automatically detect when Slack chat constitutes requirement updates
async function detectRequirementUpdate(message: string, context: AgentContext): Promise<RequirementUpdate | null> {
  const detectionPrompt = `
    Analyze this message from a human in the context of an AI agent working on a task.

    Context:
    - Current task: ${context.currentTask}
    - Files being modified: ${context.files.join(', ')}

    Message: "${message}"

    Does this message contain:
    1. A new requirement?
    2. A clarification that should be documented?
    3. A constraint that should be added to the task epic?

    If yes, extract the requirement update in structured format.
    If no, return null.
  `;

  const result = await ai.analyze(detectionPrompt);

  if (result.isRequirementUpdate) {
    // Automatically add to task epic
    await appendToTaskEpic(context.taskId, {
      type: 'requirement_update',
      content: result.requirement,
      source: 'slack',
      timestamp: new Date()
    });

    // Remind about epic and TDD
    await postSlackMessage(context.channelId, {
      text: `📝 I've added this as a requirement to the task epic. Remember to follow the AIDD TDD process!`
    });

    return result;
  }

  return null;
}
```

---

## Implementation Phases

### Phase 1: Foundation (2-3 weeks)

**Goal**: Cloud container orchestration with basic observation

1. **Container Orchestration**
   - Set up Kubernetes cluster (or start with Docker Compose for dev)
   - Create container templates for Claude Code, Codex, OpenCode
   - Implement container lifecycle API (create, start, stop, delete)
   - Git clone + branch checkout in container

2. **Database Schema**
   - Add `agentContainers` table
   - Add `agentSteeringMessages` table
   - Add `containerLogs` table for thinking streams

3. **Basic API Routes**
   - `POST /api/containers` - Spawn new agent
   - `GET /api/containers` - List containers
   - `GET /api/containers/:id` - Get container status
   - `POST /api/containers/:id/steer` - Send steering message
   - `DELETE /api/containers/:id` - Terminate agent

### Phase 2: Real-Time Observation (1-2 weeks)

**Goal**: Real-time visibility into agent thinking

1. **WebSocket Streaming**
   - Container → PageSpace: Stream thinking, tool calls, progress
   - PageSpace → Container: Steering messages, pause/resume

2. **PageSpace UI**
   - Agent dashboard with live thinking view
   - Container list with status indicators
   - Steering message input

3. **Socket.IO Rooms**
   - `container:{id}` - Container-specific events
   - `drive:{driveId}:agents` - All agents in workspace

### Phase 3: Slack Integration (1-2 weeks)

**Goal**: Full Slack bidirectional communication

1. **Slack App**
   - Create Slack app with proper scopes
   - Implement slash commands
   - Implement webhook for agent events

2. **Slack Bot**
   - Spawn/observe/steer from Slack
   - Thinking stream to Slack threads
   - PR notifications with actions

3. **Requirement Detection**
   - Analyze Slack messages for requirement updates
   - Auto-append to task epics
   - TDD process reminders

### Phase 4: AIDD Integration (2-3 weeks)

**Goal**: Full AIDD workflow support

1. **AIDD Commands as Skills**
   - Port `/task`, `/plan`, `/review`, `/execute` to PageSpace skills
   - Store AIDD rules in drive configuration

2. **Task Epic Integration**
   - Task epics stored as PageSpace pages
   - Agent containers linked to task epics
   - Progress tracking in task epic

3. **Review Workflows**
   - Pre-commit AI review hooks
   - CI-style review gates
   - Parallel review agents

### Phase 5: Team Features (2-3 weeks)

**Goal**: Multi-user team coordination

1. **Multi-User Observation**
   - Multiple users observing same agent
   - Observation notifications
   - Steering message attribution

2. **Agent Assignment**
   - Assign agents to team members
   - Handoff between users
   - Agent ownership transfer

3. **Activity Feed**
   - Unified feed of all agent activity
   - Filters by status, assignee, task
   - Digest notifications

---

## API Reference

### Container Management

```yaml
# Spawn new agent container
POST /api/containers
{
  "name": "ai-chat-refactor",
  "repository": "2witstudios/PageSpace",
  "baseBranch": "main",
  "prompt": "Refactor the AI chat system...",
  "agentType": "claude",
  "model": "claude-sonnet-4-6",
  "assignedUsers": ["user-123"],
  "taskEpicId": "task-456"  # Optional: link to AIDD task
}

# Response
{
  "containerId": "cnt-abc123",
  "status": "pending",
  "branch": "pu/ai-chat-refactor",
  "websocketUrl": "wss://pagespace.io/ws/container/cnt-abc123"
}
```

### Steering

```yaml
# Send steering message to agent
POST /api/containers/:id/steer
{
  "message": "Actually, let's use a different approach. Can you try the factory pattern instead?"
}

# Response
{
  "delivered": true,
  "timestamp": "2026-03-10T21:00:00Z"
}
```

### Observation

```yaml
# Subscribe to container events via WebSocket
ws://pagespace.io/ws/container/:id

# Events
{
  "type": "thinking",
  "content": "I'm analyzing the component structure..."
}
{
  "type": "tool_use",
  "tool": "Read",
  "input": { "file_path": "/workspace/apps/web/src/..." }
}
{
  "type": "tool_result",
  "result": "file contents..."
}
{
  "type": "steering",
  "from": "Eric",
  "message": "Try the factory pattern instead"
}
```

---

## Security Considerations

### Container Isolation

- Each container runs in isolated namespace
- No shared filesystem between containers
- Network policies restrict container-to-container communication
- Resource quotas prevent resource exhaustion

### Access Control

- Drive-level permissions apply to containers
- Only drive members can spawn/observe/steer agents
- Steering messages logged with user attribution
- API rate limiting per user/drive

### GitHub Integration

- OAuth tokens stored encrypted
- Per-container GitHub tokens (scoped to repo)
- Audit logging of all GitHub operations
- Branch protection rules enforced

---

## Cost Estimation

### Container Costs (Kubernetes)

| Resource | Per Container | Monthly Cost |
|----------|--------------|--------------|
| CPU | 2 cores | ~$50 |
| Memory | 4GB | ~$30 |
| Storage | 10GB | ~$1 |
| **Total per agent** | | **~$80/month** |

### Scaling

- 10 concurrent agents = ~$800/month
- 50 concurrent agents = ~$4,000/month
- Spot/preemptible instances = 60-80% discount

---

## Success Metrics

| Metric | Target |
|--------|--------|
| Agent spawn time | < 30 seconds |
| Thinking stream latency | < 500ms |
| Steering message delivery | < 1 second |
| Container uptime | 99.9% |
| Concurrent agents per team | 50+ |
| Slack message delivery | < 2 seconds |

---

## Conclusion

PageSpace is uniquely positioned to become the coordination layer for cloud-based AI agent orchestration because it already has:

1. ✅ Multi-tenant workspace isolation (Drives)
2. ✅ Real-time collaboration infrastructure (Socket.IO)
3. ✅ Agent-to-agent communication (ask_agent tool)
4. ✅ GitHub integration with audit logging
5. ✅ Task assignment to agents
6. ✅ Chat/messaging infrastructure

The primary additions needed are:

1. 🔧 Container orchestration layer (Kubernetes)
2. 🔧 Slack integration (bidirectional)
3. 🔧 Agent lifecycle API
4. 🔧 AIDD workflow engine integration
5. 🔧 Human-in-the-loop steering protocol

This architecture enables the vision of PageSpace as the "point guard" - coordinating multiple agents across containers, with human team members observing and steering from Slack or the PageSpace UI, all while maintaining the AIDD workflow discipline that Eric's team needs.
