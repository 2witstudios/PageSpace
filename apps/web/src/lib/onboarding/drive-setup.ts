import { db, pages, taskItems, taskLists } from '@pagespace/db';
import { createId } from '@paralleldrive/cuid2';
import { getAboutPageSpaceAgentSystemPrompt, getReferenceSeedTemplate, type SeedNodeTemplate, type SeedTaskTemplate } from './onboarding-faq';
import { buildBudgetSheetContent } from './faq/content-page-types';
import { PLANNING_ASSISTANT_SYSTEM_PROMPT } from './faq/example-agent-prompts';

type TransactionType = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DatabaseType = typeof db;
type DbClient = TransactionType | DatabaseType;

/**
 * Populates a new user's drive with starter content.
 * Each page type is a first-class item at the root so users immediately
 * see what PageSpace can do. Two general-purpose agents are included.
 */
export async function populateUserDrive(
  userId: string,
  driveId: string,
  client: DbClient = db
): Promise<void> {
  const now = new Date();

  const basePage = {
    driveId,
    isTrashed: false,
    createdAt: now,
    updatedAt: now,
  } as const;

  const insertPage = async (
    values: Omit<typeof pages.$inferInsert, keyof typeof basePage> &
      Partial<Pick<typeof pages.$inferInsert, keyof typeof basePage>>
  ): Promise<string> => {
    const id = values.id ?? createId();
    await client.insert(pages).values({
      ...basePage,
      ...values,
      id,
      content: values.content ?? '',
    });
    return id;
  };

  const seedTaskList = async (params: {
    taskListPageId: string;
    taskList: SeedNodeTemplate['taskList'];
  }): Promise<void> => {
    const { taskListPageId, taskList } = params;
    if (!taskList || taskList.tasks.length === 0) return;

    const taskListId = createId();
    await client.insert(taskLists).values({
      id: taskListId,
      userId,
      pageId: taskListPageId,
      title: taskList.title,
      description: taskList.description,
      status: 'in_progress',
      createdAt: now,
      updatedAt: now,
    });

    for (let index = 0; index < taskList.tasks.length; index += 1) {
      const task = taskList.tasks[index] as SeedTaskTemplate;
      const taskPageId = await insertPage({
        id: createId(),
        title: task.title,
        type: 'DOCUMENT',
        content: `
# ${task.title}

${task.description}
        `.trim(),
        position: index + 1,
        parentId: taskListPageId,
      });

      const dueDate =
        typeof task.dueInDays === 'number'
          ? new Date(now.getTime() + task.dueInDays * 24 * 60 * 60 * 1000)
          : null;

      await client.insert(taskItems).values({
        id: createId(),
        taskListId,
        userId,
        assigneeId: task.assignee === 'self' ? userId : null,
        pageId: taskPageId,
        title: task.title,
        description: task.description,
        status: task.status,
        priority: task.priority,
        position: index,
        dueDate,
        createdAt: now,
        updatedAt: now,
      });
    }
  };

  const seedNode = async (params: {
    node: SeedNodeTemplate;
    parentId?: string;
    position: number;
  }): Promise<string> => {
    const { node, parentId, position } = params;

    const pageId = await insertPage({
      id: createId(),
      title: node.title,
      type: node.type,
      content: node.content ?? '',
      systemPrompt: node.systemPrompt,
      agentDefinition: node.agentDefinition,
      enabledTools: node.enabledTools,
      includePageTree: node.includePageTree,
      pageTreeScope: node.pageTreeScope,
      includeDrivePrompt: node.includeDrivePrompt,
      position,
      parentId,
    });

    if (node.type === 'TASK_LIST') {
      await seedTaskList({ taskListPageId: pageId, taskList: node.taskList });
    }

    if (node.children && node.children.length > 0) {
      for (let index = 0; index < node.children.length; index += 1) {
        const child = node.children[index] as SeedNodeTemplate;
        await seedNode({
          node: child,
          parentId: pageId,
          position: index + 1,
        });
      }
    }

    return pageId;
  };

  // 1. Welcome to PageSpace (Document)
  await insertPage({
    id: createId(),
    title: 'Welcome to PageSpace',
    type: 'DOCUMENT',
    content: `
# Welcome to PageSpace

PageSpace is your all-in-one workspace for notes, tasks, data, and AI — all organized as pages in a tree.

## This drive is your playground

Every item here showcases a different page type. Open them, edit them, and make them yours.

- **Example Notes** — a Document for writing and thinking
- **Budget Tracker** — a Sheet with formulas
- **Getting Started Tasks** — a Task List where each task has its own page
- **Upload Files Here** — drop a file to see how File pages work
- **My Dashboard** — a Canvas page with custom HTML/CSS
- **General Chat** — a Channel for conversation
- **PageSpace Guide** — an AI agent that can answer questions about PageSpace
- **Planning Assistant** — an AI agent that helps you plan and organize

## Tips

- **Nest pages** inside folders to build structure. Drag and drop to reorganize.
- **Every page has AI** — use the AI sidebar on any page to chat about its content.
- **Create your own agents** by making a new AI Chat page and writing a system prompt.

Check out the **Reference** folder for guides on each page type.
    `.trim(),
    position: 1,
  });

  // 2. Example Notes (Document)
  await insertPage({
    id: createId(),
    title: 'Example Notes',
    type: 'DOCUMENT',
    content: `
# Example Notes

This is a Document page — the default page type for writing and thinking.

## What Documents are great for

- Meeting notes, specs, wikis
- Drafts and brainstorming
- Checklists and lightweight planning

## Try it

Edit this page. Add your own headings, lists, and notes. Documents support rich text formatting with markdown-style shortcuts.

## Action Items

- [ ] Edit this document to make it yours
- [ ] Try creating a new Document page
- [ ] Nest a Document inside a folder
    `.trim(),
    position: 2,
  });

  // 3. Budget Tracker (Sheet)
  await insertPage({
    id: createId(),
    title: 'Budget Tracker',
    type: 'SHEET',
    content: buildBudgetSheetContent(),
    position: 3,
  });

  // 4. Getting Started Tasks (Task List)
  const taskListPageId = await insertPage({
    id: createId(),
    title: 'Getting Started Tasks',
    type: 'TASK_LIST',
    content: '',
    position: 4,
  });
  await seedTaskList({
    taskListPageId,
    taskList: {
      title: 'Getting Started',
      description: 'Your first tasks in PageSpace. Check them off as you go.',
      tasks: [
        {
          title: 'Open and edit Example Notes',
          description: 'Open the Example Notes document and make a small edit to see how Documents work.',
          status: 'pending',
          priority: 'medium',
          assignee: 'self',
          dueInDays: 0,
        },
        {
          title: 'Change a value in Budget Tracker',
          description: 'Open the Budget Tracker sheet and change a cost value. Watch the Total formula update.',
          status: 'pending',
          priority: 'medium',
          assignee: 'self',
          dueInDays: 1,
        },
        {
          title: 'Ask the PageSpace Guide a question',
          description: 'Open the PageSpace Guide agent and ask it anything about how PageSpace works.',
          status: 'pending',
          priority: 'medium',
          assignee: 'self',
          dueInDays: 1,
        },
        {
          title: 'Create your first project folder',
          description: 'Create a new Folder page and add a couple of pages inside it. Try nesting a Document and a Task List.',
          status: 'pending',
          priority: 'low',
          assignee: 'self',
          dueInDays: 2,
        },
      ],
    },
  });

  // 5. Upload Files Here (Folder)
  await insertPage({
    id: createId(),
    title: 'Upload Files Here',
    type: 'FOLDER',
    content: '',
    position: 5,
  });

  // 6. My Dashboard (Canvas)
  await insertPage({
    id: createId(),
    title: 'My Dashboard',
    type: 'CANVAS',
    content: `
<!DOCTYPE html>
<html>
<head>
<style>
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    margin: 0;
    padding: 32px;
    background: radial-gradient(1200px circle at 20% 0%, #e0e7ff, transparent 55%),
      radial-gradient(900px circle at 80% 20%, #d1fae5, transparent 45%),
      #0b1020;
    color: #e5e7eb;
    min-height: 100vh;
  }
  .wrap { max-width: 860px; margin: 0 auto; }
  .title {
    font-size: 28px; font-weight: 650;
    letter-spacing: -0.02em; margin: 0 0 8px;
  }
  .subtitle { opacity: 0.85; margin: 0 0 22px; }
  .grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 14px;
  }
  .card {
    background: rgba(255,255,255,0.08);
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 14px; padding: 16px;
    backdrop-filter: blur(10px);
  }
  .card h3 { margin: 0 0 6px; font-size: 14px; opacity: 0.9; }
  .card p { margin: 0; font-size: 13px; opacity: 0.78; line-height: 1.35; }
  .hint {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 8px 10px; border-radius: 999px;
    background: rgba(255,255,255,0.1);
    border: 1px solid rgba(255,255,255,0.12);
    font-size: 12px; margin-top: 14px;
  }
</style>
</head>
<body>
  <div class="wrap">
    <h1 class="title">My Dashboard</h1>
    <p class="subtitle">
      This is a Canvas page. It renders custom HTML and CSS — use it for dashboards, landing pages, or navigation hubs.
    </p>

    <div class="grid">
      <div class="card">
        <h3>Write</h3>
        <p>Documents for notes, specs, and meeting logs.</p>
      </div>
      <div class="card">
        <h3>Track</h3>
        <p>Task Lists where each task has its own notes page.</p>
      </div>
      <div class="card">
        <h3>Calculate</h3>
        <p>Sheets with formulas for budgets and data.</p>
      </div>
    </div>

    <div class="hint">
      <strong>Try:</strong>
      <span>Edit this page's HTML to customize your dashboard.</span>
    </div>
  </div>
</body>
</html>
    `.trim(),
    position: 6,
  });

  // 7. General Chat (Channel)
  await insertPage({
    id: createId(),
    title: 'General Chat',
    type: 'CHANNEL',
    content: '',
    position: 7,
  });

  // 8. PageSpace Guide (AI Chat - onboarding agent)
  await insertPage({
    id: createId(),
    title: 'PageSpace Guide',
    type: 'AI_CHAT',
    content: '',
    systemPrompt: getAboutPageSpaceAgentSystemPrompt(),
    agentDefinition: 'Onboarding guide that teaches PageSpace using the reference knowledge base.',
    aiProvider: 'pagespace',
    aiModel: 'glm-4.5-air',
    enabledTools: ['read_page', 'list_pages', 'glob_search', 'regex_search'],
    includePageTree: true,
    pageTreeScope: 'drive',
    includeDrivePrompt: true,
    position: 8,
  });

  // 9. Planning Assistant (AI Chat - general-purpose planning agent)
  await insertPage({
    id: createId(),
    title: 'Planning Assistant',
    type: 'AI_CHAT',
    content: '',
    systemPrompt: PLANNING_ASSISTANT_SYSTEM_PROMPT,
    agentDefinition: 'Helps plan workspace structure, organize projects, and break down ideas into actionable steps.',
    enabledTools: ['read_page', 'list_pages', 'glob_search', 'regex_search'],
    includePageTree: true,
    pageTreeScope: 'drive',
    position: 9,
  });

  // 10. Reference (Folder + consolidated guides)
  const referenceTemplate = getReferenceSeedTemplate();
  await seedNode({ node: referenceTemplate, position: 10 });
}
