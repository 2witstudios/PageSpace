Workspace Navigation & Management:

list_drives(): List all available workspaces/drives.
create_drive(name): Create a new workspace/drive.
rename_drive(driveId, name): Rename an existing workspace/drive.
list_pages(driveId, driveSlug): List all pages in a workspace with their paths and types.
list_trash(driveSlug, driveId): List all trashed pages in a workspace.

Page Content Operations:

read_page(path, pageId): Read the content of any page.
replace_lines(path, pageId, startLine, content, endLine): Replace one or more lines in a document (use empty content to delete lines).
create_page(driveId, title, type, parentId): Create new pages (document, folder, AI chat, channel, canvas, sheet, task list).
rename_page(path, pageId, title): Change the title of an existing page.
move_page(path, pageId, newParentPath, position, newParentId): Move a page to a different parent folder or change its position.

Trash Operations (Pages & Drives):

trash(type, id, path?, withChildren?, confirmDriveName?): Move a page or drive to trash. For pages: optionally trash children recursively. For drives: requires name confirmation.
restore(type, id): Restore a trashed page or drive.

Search & Discovery:

regex_search(driveId, pattern, searchIn, maxResults): Search page content using regular expression patterns.
glob_search(driveId, pattern, maxResults, includeTypes): Find pages using glob-style patterns for titles and paths.
multi_drive_search(searchQuery, searchType, maxResultsPerDrive): Search for content across multiple drives.

Task Management:

create_page(driveId, title, type: 'TASK_LIST', parentId): Create a TASK_LIST page to manage tasks.
read_page(pageId): Read task list status and progress (returns structured task data for TASK_LIST pages).
update_task(pageId, title, description, priority, status): Add or update tasks on a TASK_LIST page (creates linked DOCUMENT page per task).

AI Agent Management:

update_agent_config(agentPath, agentId, aiModel, aiProvider, enabledTools, systemPrompt): Update the configuration of an AI agent (use create_page with type: 'AI_CHAT' first to create the agent).
list_agents(driveId, includeSystemPrompt, includeTools, driveSlug): List all AI agents in a specific drive.
multi_drive_list_agents(includeSystemPrompt, includeTools, groupByDrive): List all AI agents across all accessible drives.
ask_agent(agentPath, agentId, question, context): Consult another AI agent for specialized knowledge.
