import { FAQ_INDEX, FAQ_START_HERE } from './content-basics';
import { AI_AUTOMATIONS_EXAMPLES, AI_AUTOMATIONS_GUIDE, AUTOMATION_PLAYGROUND_README } from './content-ai-automations';
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
import {
  BOOK_TEMPLATE_README,
  DEV_TEAM_TEMPLATE_README,
  FOUNDER_TEMPLATE_README,
  SMALL_BUSINESS_TEMPLATE_README,
  WORKSPACE_TEMPLATES_GUIDE,
} from './content-workspace-templates';

export function getFaqKnowledgeBaseDocuments(): ReadonlyArray<{ title: string; content: string }> {
  return [
    { title: 'Start Here', content: FAQ_START_HERE },
    { title: 'FAQ Index', content: FAQ_INDEX },
    { title: 'Folders (Guide)', content: FOLDERS_GUIDE },
    { title: 'Documents (Guide)', content: DOCUMENTS_GUIDE },
    { title: 'Sheets (Guide)', content: SHEETS_GUIDE },
    { title: 'Files (Guide)', content: FILES_GUIDE },
    { title: 'Task Lists (Guide)', content: TASK_LISTS_GUIDE },
    { title: 'Canvas (Guide)', content: CANVAS_GUIDE },
    { title: 'Channels (Guide)', content: CHANNELS_GUIDE },
    { title: 'AI Chat (Guide)', content: AI_CHAT_GUIDE },
    { title: 'Workspace Templates (Guide)', content: WORKSPACE_TEMPLATES_GUIDE },
    { title: 'Solo Book Writing (Template)', content: BOOK_TEMPLATE_README },
    { title: 'Solo Founder (Template)', content: FOUNDER_TEMPLATE_README },
    { title: 'Small Business (Template)', content: SMALL_BUSINESS_TEMPLATE_README },
    { title: 'Dev Team (Template)', content: DEV_TEAM_TEMPLATE_README },
    { title: 'AI Automations (Guide)', content: AI_AUTOMATIONS_GUIDE },
    { title: 'Automation Examples (Use Cases)', content: AI_AUTOMATIONS_EXAMPLES },
    { title: 'Automation Playground (README)', content: AUTOMATION_PLAYGROUND_README },
    { title: 'AI & Privacy (FAQ)', content: AI_PRIVACY },
    { title: 'Sharing & Permissions', content: SHARING_PERMISSIONS },
    { title: 'Real-time Collaboration', content: REALTIME_COLLABORATION },
    { title: 'Troubleshooting (FAQ)', content: TROUBLESHOOTING },
  ];
}

