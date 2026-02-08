# Review Vector: Agent Communication

## Standards
- review.mdc
- javascript.mdc
- please.mdc
- agent-orchestrator.mdc

## Scope
**Files**: `apps/web/src/lib/ai/**`
**Level**: service

## Context
Agent-to-agent communication enables AI agents to share context, delegate tasks, and coordinate responses across page boundaries. The messaging protocol defines how agents discover each other, exchange structured payloads, and merge results. This subsystem must maintain clear ownership boundaries so that agents do not leak private page context to unauthorized conversations.
