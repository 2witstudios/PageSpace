/**
 * Welcome documentation setup for new PageSpace users
 * Creates initial pages and a help agent in new user drives
 */

import { db, pages } from '@pagespace/db';
import { createId } from '@paralleldrive/cuid2';

/**
 * Welcome page content for new users
 */
const WELCOME_CONTENT = `# Welcome to PageSpace! 🚀

**PageSpace is where AI agents collaborate alongside your team to create, edit, and organize content.**

## What You Can Do

PageSpace turns your projects into intelligent workspaces. Here's what makes it different:

### 🤖 AI with Real Tools
Your AI can create documents, organize projects, and edit content—not just answer questions. Try asking an AI to:
- Create a complete project structure
- Organize your notes into folders
- Write and format documentation
- Analyze and summarize information

### 🌲 Context-Aware Intelligence
Everything in PageSpace is a **page**—documents, folders, chats, and AI agents. This tree structure means:
- AI understands context from parent pages
- Permissions flow naturally through the hierarchy
- Your workspace mirrors how you think

### 👥 Real-Time Collaboration
Work together with your team and AI simultaneously:
- See changes as they happen
- Multiple people can edit the same document
- AI agents work alongside humans

### 🎨 Flexible Page Types

Create different types of pages for different needs:
- **Documents**: Rich text with markdown support
- **Folders**: Organize your content hierarchically
- **AI Chats**: Conversations with AI agents
- **Canvas**: Custom HTML/CSS dashboards
- **Channels**: Team discussions
- **Files**: Upload and manage files

## Getting Started

1. **Explore the sidebar** on the left to see your workspace structure
2. **Create a new page** using the + button or right-click menu
3. **Chat with an AI** by creating an AI Chat page or talking to the PageSpace Assistant
4. **Read the Quick Start Guide** (the page below this one)

## Need Help?

- **PageSpace Assistant**: Use the help agent in this folder to ask questions about PageSpace
- **Documentation**: Check out the Quick Start Guide for detailed instructions
- **Support**: Join our community at [discord.gg/yxDQkTHXT5](https://discord.gg/yxDQkTHXT5)

---

*You can edit or delete this page anytime. Welcome to your new intelligent workspace!*
`;

/**
 * Quick start guide content
 */
const QUICK_START_CONTENT = `# Quick Start Guide

This guide will help you get up and running with PageSpace quickly.

## Creating Your First Document

1. **Click the + button** in the sidebar or press \`Cmd/Ctrl + N\`
2. **Choose "Document"** from the page type menu
3. **Start typing** - PageSpace supports rich text formatting and markdown

### Formatting Tips
- Use \`**bold**\` for **bold text**
- Use \`*italic*\` for *italic text*
- Start lines with \`#\` for headings
- Use \`-\` or \`*\` for bullet lists
- Use \`1.\` for numbered lists

## Working with AI

### Creating an AI Chat
1. Click the + button and select **AI Chat**
2. Choose your AI model (free models like Qwen or premium like Claude)
3. Start chatting! The AI can see and work with pages in your workspace

### AI Capabilities
The AI in PageSpace can:
- **Create pages**: "Create a project plan for a mobile app"
- **Edit content**: "Update the introduction to be more concise"
- **Organize**: "Move all meeting notes into a folder"
- **Search**: "Find all pages about marketing"
- **Analyze**: "Summarize the key points from our strategy docs"

### System Prompts
Customize your AI agents by setting a **system prompt**:
1. Create an AI Chat page
2. Click the settings icon
3. Add a system prompt to define the agent's role and behavior

Example: *"You are a project manager who helps organize tasks and track progress."*

## Organizing Your Workspace

### Folders & Hierarchy
- **Drag and drop** pages to reorder or nest them
- **Right-click** pages for options like duplicate, move, or delete
- **Permissions inherit** - grant access to a folder to share all its children

### Using Tags
- Add **tags** to pages for cross-cutting organization
- Filter pages by tags in the sidebar
- Tags work across the entire hierarchy

### Favorites
- **Star pages** to quickly access them from the favorites section
- Perfect for frequently used documents or active projects

## Keyboard Shortcuts

- \`Cmd/Ctrl + N\`: New page
- \`Cmd/Ctrl + K\`: Quick search
- \`Cmd/Ctrl + B\`: Toggle sidebar
- \`Cmd/Ctrl + /\`: Toggle AI chat

## Collaboration Features

### Real-Time Editing
- Multiple people can edit the same page simultaneously
- See cursors and selections from other users
- Changes sync automatically

### Permissions
- **View**: Can read the page
- **Edit**: Can modify content
- **Share**: Can grant access to others
- **Delete**: Can remove the page

### Sharing
1. Right-click a page or folder
2. Select "Share"
3. Add team members and set their permission level

## Advanced Features

### MCP Integration
Connect external AI tools like Claude Desktop or Cursor to your PageSpace:
1. Install the PageSpace MCP server: \`npm install -g pagespace-mcp@latest\`
2. Configure it in Claude Desktop settings
3. External AI can now read and edit your workspace!

### Canvas Pages
Create custom dashboards with HTML and CSS:
1. Create a **Canvas** page
2. Switch to code view
3. Write custom HTML/CSS for visualizations, status boards, or custom interfaces

### Multiple AI Providers
Switch between AI providers in your settings:
- **Free models**: Qwen, DeepSeek, Llama
- **Premium models**: Claude, GPT-4, Gemini
- **Local models**: Ollama for privacy
- **Custom providers**: Add your own API keys

## Tips & Best Practices

1. **Use folders liberally** - Organize by project, topic, or time period
2. **Create specialized AI agents** - Set up agents for different tasks (writing, coding, analysis)
3. **Tag consistently** - Develop a tagging system that works for your workflow
4. **Leverage context** - Put AI chats inside relevant folders so they understand the context
5. **Experiment with prompts** - Try different system prompts to customize AI behavior

## What's Next?

- **Build a project**: Create a folder structure for your next project
- **Customize an AI agent**: Set up a specialized agent with a system prompt
- **Invite your team**: Share folders and collaborate in real-time
- **Explore integrations**: Try the MCP integration with Claude Desktop

---

*Have questions? Ask the PageSpace Assistant in this folder!*
`;

/**
 * System prompt for the PageSpace help agent
 */
const HELP_AGENT_SYSTEM_PROMPT = `You are the **PageSpace Assistant**, a helpful AI agent that guides users through using PageSpace effectively.

## Your Role

You help users understand and get the most out of PageSpace—a collaborative, AI-powered knowledge management platform. You provide:

- **Clear guidance** on how to use PageSpace features
- **Best practices** for organizing workspaces and collaborating with AI
- **Troubleshooting help** for common issues
- **Feature explanations** with practical examples

## What You Know About PageSpace

### Core Concepts
- **Pages are universal**: Everything (documents, folders, chats, AI agents) is a page
- **Tree structure**: Pages are organized hierarchically, with context flowing through the tree
- **Permissions inherit**: Access flows down the hierarchy
- **AI context flows up**: AI agents understand their parent pages' context

### Page Types
1. **DOCUMENT**: Rich text documents with markdown support
2. **FOLDER**: Containers for organizing pages hierarchically
3. **AI_CHAT**: Conversations with AI agents (can have custom system prompts)
4. **CANVAS**: Custom HTML/CSS dashboards
5. **CHANNEL**: Team discussion threads
6. **FILE**: Uploaded files and attachments
7. **SHEET**: Spreadsheet-like data (coming soon)

### AI Capabilities
AI agents in PageSpace can:
- Create, read, update, and delete pages
- Organize pages into folders
- Search across the workspace
- Work with multiple drives
- Execute tools like bulk operations
- Understand context from their location in the tree

### Key Features
- **Real-time collaboration**: Multiple users editing simultaneously
- **Permission system**: VIEW, EDIT, SHARE, DELETE levels
- **MCP integration**: External AI tools (Claude Desktop, Cursor) can access workspaces
- **Multiple AI providers**: OpenRouter, Google, OpenAI, Anthropic, xAI, Ollama
- **Tags**: Cross-cutting organization across the hierarchy
- **Favorites**: Quick access to important pages

## Your Behavior

- **Be helpful and encouraging**: PageSpace can do a lot—help users discover its power
- **Provide examples**: Show, don't just tell. Give concrete examples when explaining features
- **Understand context**: You're inside the user's workspace—you can reference their pages
- **Guide exploration**: Encourage users to experiment and build their own workflows
- **Clarify capabilities**: Help users understand what AI can and can't do in PageSpace

## Available Tools

You have access to all PageSpace tools to:
- Read and search the user's pages
- Create examples or demonstrations
- Organize content if asked
- Reference actual pages in the user's workspace

## Example Interactions

**User**: "How do I organize my notes?"
**You**: "Great question! Here are a few approaches:

1. **By project**: Create a folder for each project, with subfolders for notes, tasks, and resources
2. **By time**: Weekly folders with daily note pages
3. **By topic**: Subject-based folders with tagged pages for cross-references

Would you like me to help you set up one of these structures?"

**User**: "Can AI help me write a document?"
**You**: "Absolutely! AI in PageSpace can help in several ways:

1. **Create new documents**: Ask an AI to create a complete document from scratch
2. **Edit existing docs**: AI can revise, expand, or summarize your content
3. **Specialized agents**: Create an AI Chat with a custom system prompt like 'You are a technical writer' for consistent help

Try creating an AI Chat page and asking it to draft something for you!"

**User**: "What's the difference between a folder and a channel?"
**You**: "Good question—they serve different purposes:

**Folder** (FOLDER type):
- Organizes and groups pages hierarchically
- Mainly for structure and navigation
- Permissions flow to children
- Best for: Project organization, topic grouping

**Channel** (CHANNEL type):
- Discussion threads for team communication
- More like a conversation space
- Linear message flow
- Best for: Team chat, announcements, Q&A

In practice, you might have a Project folder containing a Team Channel for discussions about that project!"

Remember: You're here to make PageSpace accessible and powerful for every user. Guide them with patience and enthusiasm!
`;

/**
 * Welcome message for the help agent
 */
const HELP_AGENT_WELCOME = `👋 Hello! I'm your PageSpace Assistant.

I'm here to help you get the most out of PageSpace. Ask me anything about:

- How to use different features
- Best practices for organizing your workspace
- Working with AI agents
- Collaboration and permissions
- Keyboard shortcuts and tips

**Try asking:**
- "How do I create a custom AI agent?"
- "What's the best way to organize a project?"
- "How do permissions work?"
- "Show me some advanced features"

What would you like to know?
`;

/**
 * Create welcome documentation pages in a newly created drive
 *
 * @param driveId - The ID of the drive to create welcome docs in
 * @returns Array of created page IDs
 */
export async function createWelcomeDocs(driveId: string): Promise<string[]> {
  const pageIds: string[] = [];

  try {
    // Create "Getting Started" folder at the top
    const folderPosition = 1;
    const gettingStartedFolder = await db.insert(pages).values({
      id: createId(),
      title: '📚 Getting Started',
      type: 'FOLDER',
      content: '',
      position: folderPosition,
      driveId,
      parentId: null,
      isTrashed: false,
      processingStatus: 'completed',
    }).returning().then(res => res[0]);

    pageIds.push(gettingStartedFolder.id);

    // Create welcome document inside the folder
    const welcomeDoc = await db.insert(pages).values({
      id: createId(),
      title: 'Welcome to PageSpace',
      type: 'DOCUMENT',
      content: WELCOME_CONTENT,
      position: 1,
      driveId,
      parentId: gettingStartedFolder.id,
      isTrashed: false,
      processingStatus: 'completed',
    }).returning().then(res => res[0]);

    pageIds.push(welcomeDoc.id);

    // Create quick start guide inside the folder
    const quickStartDoc = await db.insert(pages).values({
      id: createId(),
      title: 'Quick Start Guide',
      type: 'DOCUMENT',
      content: QUICK_START_CONTENT,
      position: 2,
      driveId,
      parentId: gettingStartedFolder.id,
      isTrashed: false,
      processingStatus: 'completed',
    }).returning().then(res => res[0]);

    pageIds.push(quickStartDoc.id);

    // Create PageSpace Assistant (help agent) inside the folder
    const helpAgent = await db.insert(pages).values({
      id: createId(),
      title: '🤖 PageSpace Assistant',
      type: 'AI_CHAT',
      content: HELP_AGENT_WELCOME,
      position: 3,
      driveId,
      parentId: gettingStartedFolder.id,
      isTrashed: false,
      processingStatus: 'completed',
      systemPrompt: HELP_AGENT_SYSTEM_PROMPT,
      // Let the user choose their preferred AI provider/model
      aiProvider: null,
      aiModel: null,
      // Enable all tools for the help agent
      enabledTools: null, // null means all tools are enabled
    }).returning().then(res => res[0]);

    pageIds.push(helpAgent.id);

    return pageIds;
  } catch (error) {
    console.error('Error creating welcome docs:', error);
    throw error;
  }
}
