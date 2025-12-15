import { BOOK_TEMPLATE_README } from '../../content-workspace-templates';
import {
  BOOK_COACH_SYSTEM_PROMPT,
  CONTINUITY_CHECKER_SYSTEM_PROMPT,
  SPECIALIST_ENABLED_TOOLS,
} from '../../example-agent-prompts';
import type { SeedNodeTemplate } from '../../seed-types';

export function buildSoloBookWritingTemplateSeed(): SeedNodeTemplate {
  return {
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

## Audience

## Themes

- Theme 1
- Theme 2

## Constraints

- POV / tense
- tone / voice
            `.trim(),
          },
          {
            title: 'Outline',
            type: 'DOCUMENT',
            content: `
# Outline

## Part / Act structure

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
- Allowed / avoid:
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
                  description: 'Complete the draft and mark anything unfinished as TODO.',
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
              ],
            },
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
            content: `
# Outputs

Use this folder for anything an agent produces:

- draft notes
- continuity reports
- chapter plans
- revision checklists
            `.trim(),
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
  };
}

