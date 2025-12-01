Workspace Navigation & Management:

list_drives(): List all available workspaces/drives.
create_drive(name): Create a new workspace/drive.
rename_drive(driveId, name): Rename an existing workspace/drive.
trash_drive(driveId, confirmDriveName): Move a workspace/drive to trash (use with extreme caution).
restore_drive(driveId): Restore a trashed workspace/drive.
list_pages(driveId, driveSlug): List all pages in a workspace with their paths and types.
list_trash(driveSlug, driveId): List all trashed pages in a workspace.
Page Content Operations:

read_page(path, pageId): Read the content of any page.
replace_lines(path, pageId, startLine, content, endLine): Replace one or more lines in a document (use empty content to delete lines).
insert_lines(path, pageId, lineNumber, content): Insert new content at a specific line number (use line 1 for prepend, use line count + 1 for append).
create_page(driveId, title, type, aiModel, aiProvider, content, enabledTools, parentId, systemPrompt): Create new pages (document, folder, AI chat, channel, canvas).
rename_page(path, pageId, title): Change the title of an existing page.
trash_page(path, pageId, withChildren): Move a page to trash (optionally with all children).
restore_page(path, pageId): Restore a trashed page.
move_page(path, pageId, newParentPath, position, newParentId): Move a page to a different parent folder or change its position.
Search & Discovery:

regex_search(driveId, pattern, searchIn, maxResults): Search page content using regular expression patterns.
glob_search(driveId, pattern, maxResults, includeTypes): Find pages using glob-style patterns for titles and paths.
multi_drive_search(searchQuery, searchType, maxResultsPerDrive): Search for content across multiple drives.
Task Management:

create_page(driveId, title, type: 'TASK_LIST', parentId): Create a TASK_LIST page to manage tasks.
read_page(pageId): Read task list status and progress (returns structured task data for TASK_LIST pages).
update_task(pageId, title, description, priority, status): Add or update tasks on a TASK_LIST page (creates linked DOCUMENT page per task).
AI Agent Management:

create_agent(driveId, title, systemPrompt, aiModel, aiProvider, enabledTools, parentId, welcomeMessage): Create a new AI agent with custom configuration.
update_agent_config(agentPath, agentId, aiModel, aiProvider, enabledTools, systemPrompt): Update the configuration of an existing AI agent.
list_agents(driveId, includeSystemPrompt, includeTools, driveSlug): List all AI agents in a specific drive.
multi_drive_list_agents(includeSystemPrompt, includeTools, groupByDrive): List all AI agents across all accessible drives.
ask_agent(agentPath, agentId, question, context): Consult another AI agent for specialized knowledge.