import { DEV_TEAM_TEMPLATE_README } from '../../content-workspace-templates';
import { PRD_TO_SPRINT_SYSTEM_PROMPT, RFC_REVIEWER_SYSTEM_PROMPT, SPECIALIST_ENABLED_TOOLS } from '../../example-agent-prompts';
import type { SeedNodeTemplate } from '../../seed-types';

export function buildDevTeamTemplateSeed(): SeedNodeTemplate {
  return {
    title: 'Dev Team (Template)',
    type: 'FOLDER',
    children: [
      { title: 'README (Dev Team Template)', type: 'DOCUMENT', content: DEV_TEAM_TEMPLATE_README },
      {
        title: '00 Inbox',
        type: 'FOLDER',
        children: [
          {
            title: 'Bugs & Ideas (Example)',
            type: 'DOCUMENT',
            content: 'Capture raw issues here; triage them into PRDs/RFCs/tasks.',
          },
        ],
      },
      {
        title: 'Product',
        type: 'FOLDER',
        children: [
          {
            title: 'PRDs',
            type: 'FOLDER',
            children: [
              {
                title: 'PRD (Example)',
                type: 'DOCUMENT',
                content: `
# PRD (Example)

## Problem

## Users

## Requirements

## Acceptance criteria

## Risks / Open questions
                `.trim(),
              },
              { title: 'Decisions', type: 'DOCUMENT', content: 'Log product decisions here with dates and rationale.' },
            ],
          },
        ],
      },
      {
        title: 'Engineering',
        type: 'FOLDER',
        children: [
          {
            title: 'RFCs',
            type: 'FOLDER',
            children: [
              {
                title: 'RFC Template',
                type: 'DOCUMENT',
                content: `
# RFC Template

## Summary

## Motivation

## Design

## Alternatives

## Risks

## Rollout plan
                `.trim(),
              },
            ],
          },
          {
            title: 'Runbooks',
            type: 'FOLDER',
            children: [{ title: 'Runbook Template', type: 'DOCUMENT', content: 'Purpose, steps, rollback, owners.' }],
          },
        ],
      },
      {
        title: 'Sprint',
        type: 'FOLDER',
        children: [
          {
            title: 'Sprint Board (Example)',
            type: 'TASK_LIST',
            content: '',
            taskList: {
              title: 'Sprint Board',
              description: 'Example sprint tasks; replace with real work.',
              tasks: [
                {
                  title: 'Triage PRD into tasks',
                  description: 'Break the PRD into scoped tasks with acceptance criteria.',
                  status: 'in_progress',
                  priority: 'high',
                  assignee: 'self',
                  dueInDays: 1,
                },
                {
                  title: 'Write RFC',
                  description: 'Create an RFC using the template and review with the team.',
                  status: 'pending',
                  priority: 'medium',
                  assignee: 'self',
                  dueInDays: 2,
                },
              ],
            },
          },
        ],
      },
      {
        title: 'Channels',
        type: 'FOLDER',
        children: [{ title: 'Engineering Chat', type: 'CHANNEL', content: '' }],
      },
      {
        title: 'Outputs',
        type: 'FOLDER',
        children: [
          {
            title: 'Outputs go here',
            type: 'DOCUMENT',
            content: `
# Outputs

Use this folder for:

- task breakdowns from a PRD
- RFC review notes
- meeting summaries
            `.trim(),
          },
        ],
      },
      {
        title: 'Agents',
        type: 'FOLDER',
        children: [
          {
            title: 'PRD → Sprint Orchestrator (Agent)',
            type: 'AI_CHAT',
            content: '',
            systemPrompt: PRD_TO_SPRINT_SYSTEM_PROMPT,
            agentDefinition: 'Turns PRDs into sprint task breakdowns and plans.',
            enabledTools: SPECIALIST_ENABLED_TOOLS,
            includePageTree: true,
            pageTreeScope: 'drive',
          },
          {
            title: 'RFC Reviewer (Agent)',
            type: 'AI_CHAT',
            content: '',
            systemPrompt: RFC_REVIEWER_SYSTEM_PROMPT,
            agentDefinition: 'Reviews RFCs for clarity and risk.',
            enabledTools: SPECIALIST_ENABLED_TOOLS,
            includePageTree: true,
            pageTreeScope: 'drive',
          },
        ],
      },
    ],
  };
}

