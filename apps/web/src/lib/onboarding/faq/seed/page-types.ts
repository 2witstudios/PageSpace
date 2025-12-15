import {
  AI_CHAT_GUIDE,
  CANVAS_GUIDE,
  CANVAS_MINI_DASHBOARD,
  CHANNELS_GUIDE,
  DOCUMENTS_EXAMPLE,
  DOCUMENTS_GUIDE,
  FILES_GUIDE,
  FOLDERS_GUIDE,
  SHEETS_GUIDE,
  TASK_LISTS_GUIDE,
  buildBudgetSheetContent,
} from '../content-page-types';
import { EXAMPLE_AGENT_SYSTEM_PROMPT } from '../example-agent-prompts';
import type { SeedNodeTemplate } from '../seed-types';
import { getAiAutomationsSeed } from './ai-automations';
import { getWorkspaceTemplatesSeed } from './workspace-templates';

export function getPageTypesSeed(): SeedNodeTemplate {
  return {
    title: 'Page Types',
    type: 'FOLDER',
    children: [
      {
        title: 'Folders',
        type: 'FOLDER',
        children: [
          { title: 'Folders (Guide)', type: 'DOCUMENT', content: FOLDERS_GUIDE },
          {
            title: 'Folders (Example: Project Folder)',
            type: 'FOLDER',
            children: [
              {
                title: 'Project Overview (Example Doc)',
                type: 'DOCUMENT',
                content: `
# Project Overview (Example)

Use this page as the top-level overview for a project:

- Goals
- Timeline
- Key links
- Notes
                `.trim(),
              },
              {
                title: 'Meeting Notes (Example Doc)',
                type: 'DOCUMENT',
                content: DOCUMENTS_EXAMPLE,
              },
            ],
          },
        ],
      },
      {
        title: 'Documents',
        type: 'FOLDER',
        children: [
          { title: 'Documents (Guide)', type: 'DOCUMENT', content: DOCUMENTS_GUIDE },
          { title: 'Documents (Example)', type: 'DOCUMENT', content: DOCUMENTS_EXAMPLE },
        ],
      },
      {
        title: 'Sheets',
        type: 'FOLDER',
        children: [
          { title: 'Sheets (Guide)', type: 'DOCUMENT', content: SHEETS_GUIDE },
          { title: 'Sheets (Example: Budget)', type: 'SHEET', content: buildBudgetSheetContent() },
        ],
      },
      {
        title: 'Files',
        type: 'FOLDER',
        children: [
          { title: 'Files (Guide)', type: 'DOCUMENT', content: FILES_GUIDE },
          {
            title: 'Files (Example: Upload Here)',
            type: 'FOLDER',
            children: [
              {
                title: 'Upload a file into this folder',
                type: 'DOCUMENT',
                content: `
# Upload a file into this folder

When you upload a file into this folder, PageSpace will create a File page for it.

Try uploading:

- a PDF
- an image (PNG/JPG)
- a code file (TS/JS/MD)
                `.trim(),
              },
            ],
          },
        ],
      },
      {
        title: 'Task Lists',
        type: 'FOLDER',
        children: [
          { title: 'Task Lists (Guide)', type: 'DOCUMENT', content: TASK_LISTS_GUIDE },
          {
            title: 'Task Lists (Example: Project Tracker)',
            type: 'TASK_LIST',
            content: '',
            taskList: {
              title: 'Project Tracker',
              description: 'A small sample task list you can edit or delete.',
              tasks: [
                {
                  title: 'Read the FAQ Start Here',
                  description: 'Open the FAQ folder and skim the “Start Here” page.',
                  status: 'completed',
                  priority: 'low',
                  assignee: 'self',
                  dueInDays: 0,
                },
                {
                  title: 'Create your first real project folder',
                  description: 'Make a folder for a real project and add at least 2 pages inside it.',
                  status: 'in_progress',
                  priority: 'medium',
                  assignee: 'self',
                  dueInDays: 1,
                },
                {
                  title: 'Try a Sheet formula',
                  description: 'Open the Budget sheet example and change values to see totals update.',
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
        title: 'Canvas',
        type: 'FOLDER',
        children: [
          { title: 'Canvas (Guide)', type: 'DOCUMENT', content: CANVAS_GUIDE },
          { title: 'Canvas (Example: Mini Dashboard)', type: 'CANVAS', content: CANVAS_MINI_DASHBOARD },
        ],
      },
      {
        title: 'Channels',
        type: 'FOLDER',
        children: [
          { title: 'Channels (Guide)', type: 'DOCUMENT', content: CHANNELS_GUIDE },
          { title: 'Channels (Example: Team Chat)', type: 'CHANNEL', content: '' },
        ],
      },
      {
        title: 'AI Chat',
        type: 'FOLDER',
        children: [
          { title: 'AI Chat (Guide)', type: 'DOCUMENT', content: AI_CHAT_GUIDE },
          {
            title: 'AI Chat (Example Agent)',
            type: 'AI_CHAT',
            content: '',
            systemPrompt: EXAMPLE_AGENT_SYSTEM_PROMPT,
            agentDefinition: 'Brainstorming assistant that turns ideas into plans.',
          },
        ],
      },
      getWorkspaceTemplatesSeed(),
      getAiAutomationsSeed(),
    ],
  };
}

