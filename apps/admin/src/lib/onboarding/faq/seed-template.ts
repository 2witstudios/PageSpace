import { AI_PRIVACY, REALTIME_COLLABORATION, SHARING_PERMISSIONS, TROUBLESHOOTING } from './content-other';
import {
  AI_CHAT_GUIDE,
  CANVAS_GUIDE,
  CHANNELS_GUIDE,
  DOCUMENTS_GUIDE,
  FILES_GUIDE,
  FOLDERS_GUIDE,
  SHEETS_GUIDE,
  TASK_LISTS_GUIDE,
} from './content-page-types';
import type { SeedNodeTemplate } from './seed-types';

export function getReferenceSeedTemplate(): SeedNodeTemplate {
  return {
    title: 'Reference',
    type: 'FOLDER',
    children: [
      {
        title: 'Page Types Overview',
        type: 'DOCUMENT',
        content: buildPageTypesOverview(),
      },
      {
        title: 'AI & Agents',
        type: 'DOCUMENT',
        content: buildAiAndAgentsGuide(),
      },
      {
        title: 'Sharing & Collaboration',
        type: 'DOCUMENT',
        content: buildSharingAndCollaborationGuide(),
      },
      {
        title: 'Troubleshooting',
        type: 'DOCUMENT',
        content: TROUBLESHOOTING,
      },
    ],
  };
}

function buildPageTypesOverview(): string {
  return `
# Page Types Overview

Everything in PageSpace is a **page**. Pages have different types depending on what you need.

${FOLDERS_GUIDE}

---

${DOCUMENTS_GUIDE}

---

${SHEETS_GUIDE}

---

${TASK_LISTS_GUIDE}

---

${FILES_GUIDE}

---

${CANVAS_GUIDE}

---

${CHANNELS_GUIDE}

---

${AI_CHAT_GUIDE}
  `.trim();
}

function buildAiAndAgentsGuide(): string {
  return `
# AI & Agents

## Every page has AI

Use the AI sidebar on any page to ask questions about its content, get summaries, or brainstorm.

## AI Chat pages are dedicated agents

An AI Chat page is a persistent agent with:
- A **system prompt** (its permanent instructions)
- Optional **tools** (reading pages, searching, creating content)
- Conversation history that stays on the page

To create your own agent, make a new AI Chat page and write a system prompt that describes what it should do.

Tips for good agents:
- Keep them narrow — one job per agent
- Be specific in the system prompt ("You help me write specs for X")
- Give it a format (checklists, headings, step-by-step)

## Multi-agent pipelines

Agents can delegate to other agents using \`ask_agent\`. This enables orchestrator + specialist patterns where one agent coordinates the work of others.

---

${AI_PRIVACY}
  `.trim();
}

function buildSharingAndCollaborationGuide(): string {
  return `
# Sharing & Collaboration

${SHARING_PERMISSIONS}

---

${REALTIME_COLLABORATION}
  `.trim();
}
