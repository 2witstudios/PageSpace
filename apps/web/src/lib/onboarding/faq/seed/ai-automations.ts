import { AI_AUTOMATIONS_EXAMPLES, AI_AUTOMATIONS_GUIDE, AUTOMATION_PLAYGROUND_README } from '../content-ai-automations';
import {
  AUTOMATION_ORCHESTRATOR_SYSTEM_PROMPT,
  DRAFTING_SPECIALIST_SYSTEM_PROMPT,
  ORCHESTRATOR_ENABLED_TOOLS,
  SPECIALIST_ENABLED_TOOLS,
  STRUCTURE_ARCHITECT_SYSTEM_PROMPT,
  TASK_BREAKDOWN_SYSTEM_PROMPT,
} from '../example-agent-prompts';
import type { SeedNodeTemplate } from '../seed-types';

export function getAiAutomationsSeed(): SeedNodeTemplate {
  return {
    title: 'AI Automations',
    type: 'FOLDER',
    children: [
      { title: 'AI Automations (Guide)', type: 'DOCUMENT', content: AI_AUTOMATIONS_GUIDE },
      { title: 'Automation Examples (Use Cases)', type: 'DOCUMENT', content: AI_AUTOMATIONS_EXAMPLES },
      {
        title: 'Automation Playground',
        type: 'FOLDER',
        children: [
          { title: 'Automation Playground (README)', type: 'DOCUMENT', content: AUTOMATION_PLAYGROUND_README },
          {
            title: 'Automation Orchestrator (Example)',
            type: 'AI_CHAT',
            content: '',
            systemPrompt: AUTOMATION_ORCHESTRATOR_SYSTEM_PROMPT,
            agentDefinition: 'Orchestrates multi-agent pipelines using ask_agent and tool calls.',
            enabledTools: ORCHESTRATOR_ENABLED_TOOLS,
            includePageTree: true,
            pageTreeScope: 'drive',
          },
          {
            title: 'Specialist Agents',
            type: 'FOLDER',
            children: [
              {
                title: 'Structure Architect (Specialist)',
                type: 'AI_CHAT',
                content: '',
                systemPrompt: STRUCTURE_ARCHITECT_SYSTEM_PROMPT,
                agentDefinition: 'Designs workspace structures and agent roles (no execution).',
                enabledTools: SPECIALIST_ENABLED_TOOLS,
                includePageTree: true,
                pageTreeScope: 'drive',
              },
              {
                title: 'Task Breakdown (Specialist)',
                type: 'AI_CHAT',
                content: '',
                systemPrompt: TASK_BREAKDOWN_SYSTEM_PROMPT,
                agentDefinition: 'Turns documents into structured task breakdowns.',
                enabledTools: SPECIALIST_ENABLED_TOOLS,
                includePageTree: true,
                pageTreeScope: 'drive',
              },
              {
                title: 'Drafting (Specialist)',
                type: 'AI_CHAT',
                content: '',
                systemPrompt: DRAFTING_SPECIALIST_SYSTEM_PROMPT,
                agentDefinition: 'Writes first drafts for docs (SOPs, PRDs, outlines).',
                enabledTools: SPECIALIST_ENABLED_TOOLS,
                includePageTree: true,
                pageTreeScope: 'drive',
              },
            ],
          },
          {
            title: 'Inputs',
            type: 'FOLDER',
            children: [
              {
                title: 'Example PRD (Input)',
                type: 'DOCUMENT',
                content: `
# Example PRD (Input)

## Problem

Teams lose time because tasks don’t have enough context.

## Goal

Create a workflow where tasks automatically get a linked notes page and a consistent structure.

## Requirements

- Tasks should be grouped into milestones
- Each task should have acceptance criteria
- Output should be a Task List with linked task pages
                `.trim(),
              },
              {
                title: 'Example Interview Notes (Input)',
                type: 'DOCUMENT',
                content: `
# Example Interview Notes (Input)

## Who

Operations manager at a small agency

## Pain points

- Onboarding is inconsistent
- Requirements get lost in email
- No single source of truth for client status
                `.trim(),
              },
            ],
          },
          {
            title: 'Outputs',
            type: 'FOLDER',
            children: [
              {
                title: 'Outputs go here',
                type: 'DOCUMENT',
                content: 'Ask automation agents to write their created pages and summaries into this folder.',
              },
            ],
          },
        ],
      },
    ],
  };
}

