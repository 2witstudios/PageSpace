import {
  BOOK_TEMPLATE_README,
  DEV_TEAM_TEMPLATE_README,
  FOUNDER_TEMPLATE_README,
  SMALL_BUSINESS_TEMPLATE_README,
  WORKSPACE_TEMPLATES_GUIDE,
  buildFounderMetricsSheetContent,
  buildSalesPipelineSheetContent,
} from '../content-workspace-templates';
import {
  BOOK_COACH_SYSTEM_PROMPT,
  CLIENT_ONBOARDING_SYSTEM_PROMPT,
  CONTINUITY_CHECKER_SYSTEM_PROMPT,
  FOUNDER_OPS_SYSTEM_PROMPT,
  INTERVIEW_SYNTHESIZER_SYSTEM_PROMPT,
  PRD_TO_SPRINT_SYSTEM_PROMPT,
  RFC_REVIEWER_SYSTEM_PROMPT,
  SOP_WRITER_SYSTEM_PROMPT,
  SPECIALIST_ENABLED_TOOLS,
} from '../example-agent-prompts';
import type { SeedNodeTemplate } from '../seed-types';

export function getWorkspaceTemplatesSeed(): SeedNodeTemplate {
  return {
    title: 'Workspace Templates',
    type: 'FOLDER',
    children: [
      { title: 'Workspace Templates (Guide)', type: 'DOCUMENT', content: WORKSPACE_TEMPLATES_GUIDE },
      {
        title: 'Solo Book Writing (Template)',
        type: 'FOLDER',
        children: [
          { title: 'README (Book Template)', type: 'DOCUMENT', content: BOOK_TEMPLATE_README },
          {
            title: '00 Inbox',
            type: 'FOLDER',
            children: [
              {
                title: 'Idea Capture (Example)',
                type: 'DOCUMENT',
                content: `
# Idea Capture (Example)

Use this page for messy capture:

- scene idea
- dialogue snippet
- character note
- research question
                `.trim(),
              },
            ],
          },
          {
            title: '01 Manuscript',
            type: 'FOLDER',
            children: [
              {
                title: 'Book Brief',
                type: 'DOCUMENT',
                content: `
# Book Brief

## Premise

Write 2–5 sentences.

## Audience

Who is this for?

## Themes

- Theme 1
- Theme 2

## Constraints

- Tone/voice constraints
- POV constraints
                `.trim(),
              },
              {
                title: 'Outline',
                type: 'DOCUMENT',
                content: `
# Outline

## Act / Part structure

## Chapter beats (high level)

1. Chapter 01:
2. Chapter 02:
3. Chapter 03:
                `.trim(),
              },
              {
                title: 'Style Guide',
                type: 'DOCUMENT',
                content: `
# Style Guide

- POV:
- Tense:
- Voice:
- Allowed/avoid:
- Formatting notes:
                `.trim(),
              },
              {
                title: 'Chapters',
                type: 'FOLDER',
                children: [
                  {
                    title: 'Chapter 01 (Example)',
                    type: 'DOCUMENT',
                    content: `
# Chapter 01

## Outline

- Beat 1
- Beat 2

## Draft

Start writing here.
                    `.trim(),
                  },
                  {
                    title: 'Chapter 02 (Example)',
                    type: 'DOCUMENT',
                    content: `
# Chapter 02

## Outline

- Beat 1
- Beat 2

## Draft

Start writing here.
                    `.trim(),
                  },
                ],
              },
            ],
          },
          {
            title: '02 Research',
            type: 'FOLDER',
            children: [
              {
                title: 'Character Bible',
                type: 'DOCUMENT',
                content: `
# Character Bible

## Main characters

### Character 1

- Goals:
- Fears:
- Relationships:
- Voice notes:

### Character 2

- Goals:
- Fears:
- Relationships:
- Voice notes:
                `.trim(),
              },
              {
                title: 'World Notes',
                type: 'DOCUMENT',
                content: `
# World Notes

- Rules of the world
- Timeline constraints
- Places
- Cultural notes
                `.trim(),
              },
              {
                title: 'Sources',
                type: 'DOCUMENT',
                content: `
# Sources

Add links and notes for references you might cite or re-check later.
                `.trim(),
              },
            ],
          },
          {
            title: '03 Publishing',
            type: 'FOLDER',
            children: [
              {
                title: 'Publishing Checklist (Example)',
                type: 'TASK_LIST',
                content: '',
                taskList: {
                  title: 'Publishing Checklist',
                  description: 'Example tasks for getting a draft ready to publish.',
                  tasks: [
                    {
                      title: 'Finish first draft',
                      description: 'Complete all chapters and mark anything unfinished as TODOs.',
                      status: 'in_progress',
                      priority: 'high',
                      assignee: 'self',
                      dueInDays: 7,
                    },
                    {
                      title: 'Continuity pass',
                      description: 'Check timeline, character facts, and unresolved threads.',
                      status: 'pending',
                      priority: 'medium',
                      assignee: 'self',
                      dueInDays: 10,
                    },
                    {
                      title: 'Copy edit pass',
                      description: 'Grammar, clarity, and voice consistency.',
                      status: 'pending',
                      priority: 'medium',
                      assignee: 'self',
                      dueInDays: 14,
                    },
                  ],
                },
              },
            ],
          },
          {
            title: 'Agents',
            type: 'FOLDER',
            children: [
              {
                title: 'Book Coach (Agent)',
                type: 'AI_CHAT',
                content: '',
                systemPrompt: BOOK_COACH_SYSTEM_PROMPT,
                agentDefinition: 'Book planning and writing coach for this template.',
                enabledTools: SPECIALIST_ENABLED_TOOLS,
                includePageTree: true,
                pageTreeScope: 'drive',
              },
              {
                title: 'Continuity Checker (Agent)',
                type: 'AI_CHAT',
                content: '',
                systemPrompt: CONTINUITY_CHECKER_SYSTEM_PROMPT,
                agentDefinition: 'Checks continuity across chapters and research notes.',
                enabledTools: SPECIALIST_ENABLED_TOOLS,
                includePageTree: true,
                pageTreeScope: 'drive',
              },
            ],
          },
        ],
      },
      {
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
      },
      {
        title: 'Small Business (Template)',
        type: 'FOLDER',
        children: [
          { title: 'README (Small Business Template)', type: 'DOCUMENT', content: SMALL_BUSINESS_TEMPLATE_README },
          {
            title: '00 Inbox',
            type: 'FOLDER',
            children: [
              {
                title: 'Requests (Example)',
                type: 'DOCUMENT',
                content: 'Capture incoming requests here, then route them to the right client/project.',
              },
            ],
          },
          {
            title: 'Clients',
            type: 'FOLDER',
            children: [
              {
                title: 'Client - ExampleCo',
                type: 'FOLDER',
                children: [
                  {
                    title: 'Overview',
                    type: 'DOCUMENT',
                    content: `
# Client Overview

## Goals

## Stakeholders

## Timeline

## Key links / files
                    `.trim(),
                  },
                  {
                    title: 'Onboarding Tasks',
                    type: 'TASK_LIST',
                    content: '',
                    taskList: {
                      title: 'Client Onboarding',
                      description: 'Example onboarding tasks for a new client.',
                      tasks: [
                        {
                          title: 'Collect requirements',
                          description: 'Schedule kickoff + capture requirements in Notes.',
                          status: 'in_progress',
                          priority: 'high',
                          assignee: 'self',
                          dueInDays: 2,
                        },
                        {
                          title: 'Set up deliverables tracker',
                          description: 'Create a doc or task list for deliverables and owners.',
                          status: 'pending',
                          priority: 'medium',
                          assignee: 'self',
                          dueInDays: 3,
                        },
                      ],
                    },
                  },
                  { title: 'Notes', type: 'DOCUMENT', content: 'Meeting notes, decisions, and updates go here.' },
                  { title: 'Client Chat (Channel)', type: 'CHANNEL', content: '' },
                ],
              },
            ],
          },
          {
            title: 'Operations',
            type: 'FOLDER',
            children: [
              {
                title: 'SOPs',
                type: 'FOLDER',
                children: [
                  {
                    title: 'SOP Template',
                    type: 'DOCUMENT',
                    content: `
# SOP Template

## Purpose

## When to use this

## Steps

1.
2.
3.

## Pitfalls

## Definition of done
                    `.trim(),
                  },
                ],
              },
            ],
          },
          {
            title: 'Sales & Marketing',
            type: 'FOLDER',
            children: [{ title: 'Sales Pipeline (Example Sheet)', type: 'SHEET', content: buildSalesPipelineSheetContent() }],
          },
          {
            title: 'Agents',
            type: 'FOLDER',
            children: [
              {
                title: 'Client Onboarding (Agent)',
                type: 'AI_CHAT',
                content: '',
                systemPrompt: CLIENT_ONBOARDING_SYSTEM_PROMPT,
                agentDefinition: 'Creates repeatable client onboarding checklists and templates.',
                enabledTools: SPECIALIST_ENABLED_TOOLS,
                includePageTree: true,
                pageTreeScope: 'drive',
              },
              {
                title: 'SOP Writer (Agent)',
                type: 'AI_CHAT',
                content: '',
                systemPrompt: SOP_WRITER_SYSTEM_PROMPT,
                agentDefinition: 'Writes clear SOP drafts from messy descriptions.',
                enabledTools: SPECIALIST_ENABLED_TOOLS,
                includePageTree: true,
                pageTreeScope: 'drive',
              },
            ],
          },
        ],
      },
      {
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
          { title: 'Channels', type: 'FOLDER', children: [{ title: 'Engineering Chat', type: 'CHANNEL', content: '' }] },
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
      },
    ],
  };
}

