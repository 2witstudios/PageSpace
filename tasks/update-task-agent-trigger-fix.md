# Update Task Agent Trigger Fix

**Status**: 📋 PLANNED
**Goal**: Let AI-driven task updates succeed when no trigger was actually requested.

## Requirements

- Given an AI `update_task` call includes an incomplete `agentTrigger` with no prompt and no instruction page, should treat that trigger input as absent and still apply the task update
- Given a valid `agentTrigger` with scheduling instructions, should continue to create the requested task trigger workflow
