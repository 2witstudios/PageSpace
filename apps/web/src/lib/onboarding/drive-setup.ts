import { db, pages, taskItems, taskLists } from '@pagespace/db';
import { createId } from '@paralleldrive/cuid2';
import { getAboutPageSpaceAgentSystemPrompt, getOnboardingFaqSeedTemplate, type SeedNodeTemplate, type SeedTaskTemplate } from './onboarding-faq';

/**
 * Populates a new user's drive with starter content.
 * This includes a welcome guide, an FAQ knowledge base with page-type tutorials,
 * and an AI agent configured to help with PageSpace.
 */
export async function populateUserDrive(userId: string, driveId: string): Promise<void> {
  try {
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
      await db.insert(pages).values({
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
      await db.insert(taskLists).values({
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

        await db.insert(taskItems).values({
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
# Welcome to PageSpace! 🚀

PageSpace is your all-in-one workspace for notes, tasks, data, and AI agents. This drive has been populated with some examples to help you get started.

## What's in this drive?

- **FAQ**: A folder containing tutorials and examples for every page type.
- **About PageSpace Agent**: An AI agent you can chat with to learn more about PageSpace.
- **PageSpace Visual Guide**: A canvas page demonstrating our visual capabilities.

## Key Features

1.  **AI Integration**: Every page has AI capabilities. You can chat with your data or create specialized AI agents.
2.  **Flexible Structure**: Nest pages infinitely. Folders can contain documents, sheets, task lists, and more.
3.  **Real-time Collaboration**: Work together with your team in real-time.

## Getting Help

If you have any questions, try asking the **About PageSpace Agent** in this drive — it’s configured to use the FAQ as its knowledge base.
      `.trim(),
      position: 1,
    });

    // 2. FAQ (Folder + nested structure)
    const faqTemplate = getOnboardingFaqSeedTemplate();
    await seedNode({ node: faqTemplate, position: 2 });

    // 3. About PageSpace Agent (AI Chat)
    await insertPage({
      id: createId(),
      title: 'About PageSpace Agent',
      type: 'AI_CHAT',
      content: '', // Chat history starts empty
      systemPrompt: getAboutPageSpaceAgentSystemPrompt(),
      agentDefinition: 'Onboarding guide that teaches PageSpace using the FAQ knowledge base.',
      aiProvider: 'pagespace',
      aiModel: 'glm-4.5-air',
      enabledTools: ['read_page', 'list_pages', 'glob_search', 'regex_search'],
      includePageTree: true,
      pageTreeScope: 'drive',
      position: 3,
    });

    // 4. PageSpace Visual Guide (Canvas)
    await insertPage({
      id: createId(),
      title: 'PageSpace Visual Guide',
      type: 'CANVAS',
      content: `
<!DOCTYPE html>
<html>
<head>
<style>
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    color: #1a1a1a;
    padding: 40px;
    background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
    min-height: 100vh;
  }
  .card {
    background: white;
    border-radius: 12px;
    padding: 24px;
    box-shadow: 0 4px 6px rgba(0,0,0,0.1);
    max-width: 600px;
    margin: 0 auto;
  }
  h1 {
    color: #2563eb;
    margin-top: 0;
  }
  .feature {
    display: flex;
    align-items: center;
    margin: 16px 0;
  }
  .icon {
    width: 32px;
    height: 32px;
    background: #e0e7ff;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    margin-right: 16px;
    color: #4f46e5;
  }
</style>
</head>
<body>
  <div class="card">
    <h1>Visual Pages</h1>
    <p>This is a Canvas page. It renders standard HTML and CSS, allowing you to build completely custom interfaces right inside PageSpace.</p>
    
    <div class="feature">
      <div>
        <strong>Rich Documents</strong>
        <div style="font-size: 0.9em; color: #666;">Create beautiful docs with markdown and components.</div>
      </div>
    </div>

    <div class="feature">
      <div>
        <strong>AI Agents</strong>
        <div style="font-size: 0.9em; color: #666;">Chat with custom agents trained on your data.</div>
      </div>
    </div>

    <div class="feature">
      <div>
        <strong>Data Tools</strong>
        <div style="font-size: 0.9em; color: #666;">Sheets and Task Lists for your structured data.</div>
      </div>
    </div>
  </div>
</body>
</html>
      `.trim(),
      position: 4,
    });

  } catch (error) {
    console.error('Error populating user drive:', error);
    // We shouldn't throw here to avoid failing the signup process
    // just because starter content failed.
  }
}
