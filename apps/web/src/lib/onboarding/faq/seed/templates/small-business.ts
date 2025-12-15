import { SMALL_BUSINESS_TEMPLATE_README, buildSalesPipelineSheetContent } from '../../content-workspace-templates';
import {
  CLIENT_ONBOARDING_SYSTEM_PROMPT,
  SOP_WRITER_SYSTEM_PROMPT,
  SPECIALIST_ENABLED_TOOLS,
} from '../../example-agent-prompts';
import type { SeedNodeTemplate } from '../../seed-types';

export function buildSmallBusinessTemplateSeed(): SeedNodeTemplate {
  return {
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
        title: 'Outputs',
        type: 'FOLDER',
        children: [
          {
            title: 'Outputs go here',
            type: 'DOCUMENT',
            content: `
# Outputs

Use this folder for:

- drafted SOPs
- onboarding checklists
- client update summaries
            `.trim(),
          },
        ],
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
  };
}

