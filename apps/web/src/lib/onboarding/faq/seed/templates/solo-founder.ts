import { FOUNDER_TEMPLATE_README, buildFounderMetricsSheetContent } from '../../content-workspace-templates';
import { FOUNDER_OPS_SYSTEM_PROMPT, INTERVIEW_SYNTHESIZER_SYSTEM_PROMPT, SPECIALIST_ENABLED_TOOLS } from '../../example-agent-prompts';
import type { SeedNodeTemplate } from '../../seed-types';

export function buildSoloFounderTemplateSeed(): SeedNodeTemplate {
  return {
    title: 'Solo Founder (Template)',
    type: 'FOLDER',
    children: [
      { title: 'README (Founder Template)', type: 'DOCUMENT', content: FOUNDER_TEMPLATE_README },
      {
        title: '00 Inbox',
        type: 'FOLDER',
        children: [
          {
            title: 'Quick Capture (Example)',
            type: 'DOCUMENT',
            content: 'Use this page for quick capture. Convert it into PRDs/tasks later.',
          },
        ],
      },
      {
        title: 'Product',
        type: 'FOLDER',
        children: [
          {
            title: 'Vision',
            type: 'DOCUMENT',
            content: `
# Vision

## What are we building?

## For whom?

## Why now?

## What will we NOT do?
            `.trim(),
          },
          {
            title: 'PRDs',
            type: 'FOLDER',
            children: [
              {
                title: 'PRD Template',
                type: 'DOCUMENT',
                content: `
# PRD Template

## Problem

## Users & use cases

## Success metrics

## Requirements

## Non-goals

## Open questions
                `.trim(),
              },
            ],
          },
          {
            title: 'Roadmap (Example)',
            type: 'TASK_LIST',
            content: '',
            taskList: {
              title: 'Roadmap',
              description: 'Example roadmap tasks you can replace with real items.',
              tasks: [
                {
                  title: 'Define onboarding success metrics',
                  description: 'Pick 1–2 activation metrics and how you’ll measure them.',
                  status: 'in_progress',
                  priority: 'high',
                  assignee: 'self',
                  dueInDays: 3,
                },
                {
                  title: 'Run 5 customer interviews',
                  description: 'Capture notes in Customers → Interviews and synthesize insights.',
                  status: 'pending',
                  priority: 'medium',
                  assignee: 'self',
                  dueInDays: 7,
                },
              ],
            },
          },
        ],
      },
      {
        title: 'Customers',
        type: 'FOLDER',
        children: [
          {
            title: 'Interviews',
            type: 'FOLDER',
            children: [
              {
                title: 'Interview Notes (Example)',
                type: 'DOCUMENT',
                content: `
# Interview Notes (Example)

## Who

## Context

## Key quotes

## Pain points

## Workarounds

## Follow-up questions
                `.trim(),
              },
            ],
          },
          {
            title: 'Insights',
            type: 'DOCUMENT',
            content: `
# Insights

Collect synthesized patterns from interviews here.
            `.trim(),
          },
        ],
      },
      {
        title: 'Operations',
        type: 'FOLDER',
        children: [
          {
            title: 'Weekly Review',
            type: 'DOCUMENT',
            content: `
# Weekly Review

## Wins

## Losses

## Metrics

## What I learned

## Next week priorities
            `.trim(),
          },
          { title: 'Metrics (Example Sheet)', type: 'SHEET', content: buildFounderMetricsSheetContent() },
        ],
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

Use this folder for drafts an agent produces:

- interview summaries
- insight writeups
- PRD skeletons
- weekly plans
            `.trim(),
          },
        ],
      },
      {
        title: 'Agents',
        type: 'FOLDER',
        children: [
          {
            title: 'Founder Ops (Agent)',
            type: 'AI_CHAT',
            content: '',
            systemPrompt: FOUNDER_OPS_SYSTEM_PROMPT,
            agentDefinition: 'Weekly planning and ops assistant for founders.',
            enabledTools: SPECIALIST_ENABLED_TOOLS,
            includePageTree: true,
            pageTreeScope: 'drive',
          },
          {
            title: 'Interview Synthesizer (Agent)',
            type: 'AI_CHAT',
            content: '',
            systemPrompt: INTERVIEW_SYNTHESIZER_SYSTEM_PROMPT,
            agentDefinition: 'Turns interview notes into insights and requirements.',
            enabledTools: SPECIALIST_ENABLED_TOOLS,
            includePageTree: true,
            pageTreeScope: 'drive',
          },
        ],
      },
    ],
  };
}

