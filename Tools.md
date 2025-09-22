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
read_current_page(): Read the content of the current page the user is viewing.
replace_lines(path, pageId, startLine, content, endLine): Replace one or more lines in a document.
insert_lines(path, pageId, lineNumber, content): Insert new content at a specific line number.
delete_lines(path, pageId, startLine, endLine): Delete one or more lines from a document.
create_page(driveId, title, type, aiModel, aiProvider, content, enabledTools, parentId, systemPrompt): Create new pages (document, folder, AI chat, channel, canvas).
rename_page(path, pageId, title): Change the title of an existing page.
trash_page(path, pageId): Move a single page to trash.
append_to_page(path, pageId, content): Append content to the end of an existing page.
prepend_to_page(path, pageId, content): Prepend content to the beginning of an existing page.
trash_page_with_children(path, pageId): Move a page and all its children to trash recursively.
restore_page(path, pageId): Restore a trashed page.
move_page(path, pageId, newParentPath, position, newParentId): Move a page to a different parent folder or change its position.
Search & Discovery:

regex_search(driveId, pattern, searchIn, maxResults): Search page content using regular expression patterns.
glob_search(driveId, pattern, maxResults, includeTypes): Find pages using glob-style patterns for titles and paths.
multi_drive_search(searchQuery, searchType, maxResultsPerDrive): Search for content across multiple drives.
Task Management:

create_task_list(title, tasks, contextDriveId, contextPageId, description): Create a task list to track progress.
get_task_list(includeCompleted, taskListId): Get the current status of a task list.
update_task_status(taskId, status, note): Update the status of a specific task.
add_task(taskListId, title, priority, description, estimatedMinutes, position): Add a new task to an existing task list.
add_task_note(taskId, note, updateStatus): Add a note or progress update to a specific task.
resume_task_list(searchTitle, taskListId): Resume working on a task list from a previous conversation.
Bulk Operations:

bulk_move_pages(pageIds, targetDriveId, maintainOrder, targetParentId): Move multiple pages.
bulk_rename_pages(pageIds, renamePattern): Rename multiple pages using patterns.
bulk_delete_pages(pageIds, includeChildren): Delete multiple pages.
bulk_update_content(updates): Update content in multiple pages.
create_folder_structure(driveId, structure, parentId): Create a complex folder structure with nesting.
AI Agent Management:

create_agent(driveId, title, systemPrompt, aiModel, aiProvider, enabledTools, parentId, welcomeMessage): Create a new AI agent with custom configuration.
update_agent_config(agentPath, agentId, aiModel, aiProvider, enabledTools, systemPrompt): Update the configuration of an existing AI agent.
list_agents(driveId, includeSystemPrompt, includeTools, driveSlug): List all AI agents in a specific drive.
multi_drive_list_agents(includeSystemPrompt, includeTools, groupByDrive): List all AI agents across all accessible drives.
ask_agent(agentPath, agentId, question, context): Consult another AI agent for specialized knowledge.