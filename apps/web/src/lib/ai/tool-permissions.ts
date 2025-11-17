/**
 * Tool Permission System for Agent Roles
 * 
 * Filters and modifies available tools based on agent role permissions.
 * Ensures PLANNER role only gets read-only tools while WRITER gets
 * streamlined execution tools.
 */

import { AgentRole, ROLE_PERMISSIONS } from './agent-roles';
import type { Tool } from 'ai';

/**
 * Tool operation types for classification
 */
export enum ToolOperation {
  READ = 'read',
  WRITE = 'write',
  DELETE = 'delete',
  CREATE = 'create',
  ORGANIZE = 'organize',
  EXPLORE = 'explore'
}

/**
 * Tool metadata for permission checking
 */
export interface ToolMetadata {
  name: string;
  operation: ToolOperation;
  description: string;
  requiresConfirmation?: boolean;
  destructive?: boolean;
}

/**
 * Available tools with their operation classifications
 */
export const TOOL_METADATA: Record<string, ToolMetadata> = {
  list_drives: {
    name: 'list_drives',
    operation: ToolOperation.EXPLORE,
    description: 'Discover available workspaces/drives'
  },
  list_pages: {
    name: 'list_pages',
    operation: ToolOperation.EXPLORE,
    description: 'Explore folder structure and content'
  },
  read_page: {
    name: 'read_page',
    operation: ToolOperation.READ,
    description: 'Read existing content for context'
  },
  create_page: {
    name: 'create_page',
    operation: ToolOperation.CREATE,
    description: 'Create new documents, folders, AI chats, or channels',
    requiresConfirmation: true
  },
  rename_page: {
    name: 'rename_page',
    operation: ToolOperation.WRITE,
    description: 'Rename existing pages'
  },
  replace_lines: {
    name: 'replace_lines',
    operation: ToolOperation.WRITE,
    description: 'Replace specific lines in a document with new content'
  },
  insert_lines: {
    name: 'insert_lines',
    operation: ToolOperation.WRITE,
    description: 'Insert new content at a specific line number'
  },
  trash_page: {
    name: 'trash_page',
    operation: ToolOperation.DELETE,
    description: 'Delete pages (optionally with all children recursively)',
    requiresConfirmation: true,
    destructive: true
  },
  restore_page: {
    name: 'restore_page',
    operation: ToolOperation.ORGANIZE,
    description: 'Restore trashed pages back to their original location'
  },
  move_page: {
    name: 'move_page',
    operation: ToolOperation.ORGANIZE,
    description: 'Move pages between folders or reorder them'
  },
  list_trash: {
    name: 'list_trash',
    operation: ToolOperation.EXPLORE,
    description: 'See what pages are in the trash for a drive'
  },

  // Agent communication tools
  ask_agent: {
    name: 'ask_agent',
    operation: ToolOperation.READ,
    description: 'Consult another AI agent for specialized knowledge'
  },
  list_agents: {
    name: 'list_agents',
    operation: ToolOperation.EXPLORE,
    description: 'List AI agents in a drive'
  },
  multi_drive_list_agents: {
    name: 'multi_drive_list_agents',
    operation: ToolOperation.EXPLORE,
    description: 'List AI agents across all drives'
  },

  // Agent management tools
  create_agent: {
    name: 'create_agent',
    operation: ToolOperation.CREATE,
    description: 'Create a new AI agent',
    requiresConfirmation: true
  },
  update_agent_config: {
    name: 'update_agent_config',
    operation: ToolOperation.WRITE,
    description: 'Update agent configuration'
  },

  // Drive management tools
  create_drive: {
    name: 'create_drive',
    operation: ToolOperation.CREATE,
    description: 'Create a new drive/workspace',
    requiresConfirmation: true
  },
  rename_drive: {
    name: 'rename_drive',
    operation: ToolOperation.WRITE,
    description: 'Rename a drive'
  },
  trash_drive: {
    name: 'trash_drive',
    operation: ToolOperation.DELETE,
    description: 'Delete a drive',
    requiresConfirmation: true,
    destructive: true
  },
  restore_drive: {
    name: 'restore_drive',
    operation: ToolOperation.ORGANIZE,
    description: 'Restore a trashed drive'
  },

  // Search tools
  regex_search: {
    name: 'regex_search',
    operation: ToolOperation.READ,
    description: 'Search using regex patterns'
  },
  glob_search: {
    name: 'glob_search',
    operation: ToolOperation.READ,
    description: 'Search using glob patterns'
  },
  multi_drive_search: {
    name: 'multi_drive_search',
    operation: ToolOperation.READ,
    description: 'Search across multiple drives'
  },
  web_search: {
    name: 'web_search',
    operation: ToolOperation.READ,
    description: 'Search the web for current information and resources'
  },

  // Task management tools
  create_task_list: {
    name: 'create_task_list',
    operation: ToolOperation.CREATE,
    description: 'Create a new task list'
  },
  get_task_list: {
    name: 'get_task_list',
    operation: ToolOperation.READ,
    description: 'Get current task list'
  },
  update_task_status: {
    name: 'update_task_status',
    operation: ToolOperation.WRITE,
    description: 'Update task status'
  },
  add_task: {
    name: 'add_task',
    operation: ToolOperation.WRITE,
    description: 'Add a new task'
  },
  resume_task_list: {
    name: 'resume_task_list',
    operation: ToolOperation.WRITE,
    description: 'Resume task list processing'
  }
};

/**
 * Tool permission filter based on agent roles
 */
export class ToolPermissionFilter {
  /**
   * Filter tools based on agent role permissions
   */
  static filterTools<T extends Record<string, Tool>>(tools: T, role: AgentRole): Partial<T> {
    const permissions = ROLE_PERMISSIONS[role];
    const filteredTools: Partial<T> = {};

    for (const [toolName, tool] of Object.entries(tools)) {
      const metadata = TOOL_METADATA[toolName];
      if (!metadata) {
        // Unknown tool, allow by default but log warning
        console.warn(`Unknown tool ${toolName} encountered in permission filter`);
        filteredTools[toolName as keyof T] = tool as T[keyof T];
        continue;
      }

      if (this.isToolAllowed(metadata, permissions)) {
        // Modify tool based on role-specific behavior
        filteredTools[toolName as keyof T] = this.modifyToolForRole(tool, metadata, role) as T[keyof T];
      }
    }

    return filteredTools;
  }

  /**
   * Check if a tool is allowed for the given permissions
   */
  private static isToolAllowed(
    metadata: ToolMetadata, 
    permissions: typeof ROLE_PERMISSIONS[AgentRole]
  ): boolean {
    switch (metadata.operation) {
      case ToolOperation.READ:
      case ToolOperation.EXPLORE:
        return permissions.canRead;
      
      case ToolOperation.WRITE:
      case ToolOperation.CREATE:
      case ToolOperation.ORGANIZE:
        return permissions.canWrite;
      
      case ToolOperation.DELETE:
        return permissions.canDelete;
      
      default:
        return false;
    }
  }

  /**
   * Modify tool behavior based on agent role
   */
  private static modifyToolForRole(
    tool: Tool, 
    metadata: ToolMetadata, 
    role: AgentRole
  ): Tool {
    const modifiedTool = { ...tool } as Tool & { _roleHints?: Record<string, unknown>; _permissions?: Record<string, unknown> };

    // Add role-specific behavior hints
    if (role === AgentRole.WRITER) {
      // Writer mode: streamlined, no confirmation prompts
      modifiedTool._roleHints = {
        skipConfirmation: true,
        conciseOutput: true,
        focusOnExecution: true
      };
    } else if (role === AgentRole.PARTNER) {
      // Partner mode: collaborative, ask before destructive actions
      modifiedTool._roleHints = {
        explainActions: true,
        askBeforeDestructive: metadata.destructive,
        provideSuggestions: true
      };
    } else if (role === AgentRole.PLANNER) {
      // Planner mode: analysis focused
      modifiedTool._roleHints = {
        analyzeOnly: true,
        gatherContext: true,
        noModifications: true
      };
    }

    // Add permission context to tool
    const permissions = ROLE_PERMISSIONS[role];
    modifiedTool._permissions = {
      role,
      operation: metadata.operation,
      requiresConfirmation: permissions.requiresConfirmation && metadata.requiresConfirmation
    };

    return modifiedTool;
  }

  /**
   * Get allowed tools summary for a role
   */
  static getToolsSummary(role: AgentRole): {
    allowed: string[];
    denied: string[];
    total: number;
  } {
    const permissions = ROLE_PERMISSIONS[role];
    const allowed: string[] = [];
    const denied: string[] = [];

    for (const [toolName, metadata] of Object.entries(TOOL_METADATA)) {
      if (this.isToolAllowed(metadata, permissions)) {
        allowed.push(toolName);
      } else {
        denied.push(toolName);
      }
    }

    return {
      allowed,
      denied,
      total: Object.keys(TOOL_METADATA).length
    };
  }

  /**
   * Get role-specific tool descriptions for prompts
   */
  static getToolDescriptionsForRole(role: AgentRole): string {
    const permissions = ROLE_PERMISSIONS[role];
    const descriptions: string[] = [];

    for (const [toolName, metadata] of Object.entries(TOOL_METADATA)) {
      if (this.isToolAllowed(metadata, permissions)) {
        let desc = `${toolName}: ${metadata.description}`;
        
        // Add role-specific usage hints
        if (role === AgentRole.PLANNER && metadata.operation !== ToolOperation.READ && metadata.operation !== ToolOperation.EXPLORE) {
          desc += ' (analysis only)';
        } else if (role === AgentRole.WRITER && metadata.requiresConfirmation) {
          desc += ' (execute directly)';
        } else if (role === AgentRole.PARTNER && metadata.destructive) {
          desc += ' (ask before using)';
        }
        
        descriptions.push(desc);
      }
    }

    return descriptions.join('\n');
  }

  /**
   * Validate tool execution permission at runtime
   */
  static canExecuteTool(toolName: string, role: AgentRole): {
    allowed: boolean;
    reason?: string;
  } {
    const metadata = TOOL_METADATA[toolName];
    if (!metadata) {
      return { allowed: false, reason: `Unknown tool: ${toolName}` };
    }

    const permissions = ROLE_PERMISSIONS[role];
    const allowed = this.isToolAllowed(metadata, permissions);

    if (!allowed) {
      let reason = `Role ${role} does not have permission for ${metadata.operation} operations`;
      if (role === AgentRole.PLANNER && (metadata.operation === ToolOperation.WRITE || metadata.operation === ToolOperation.DELETE)) {
        reason = 'PLANNER role is read-only and cannot modify content';
      }
      return { allowed: false, reason };
    }

    return { allowed: true };
  }

  /**
   * Get role capability description for UI
   */
  static getRoleCapabilityDescription(role: AgentRole): string {
    const summary = this.getToolsSummary(role);
    
    switch (role) {
      case AgentRole.PARTNER:
        return `Full capabilities: Can read, create, modify, and organize content (${summary.allowed.length}/${summary.total} tools available)`;
      
      case AgentRole.PLANNER:
        return `Read-only: Can explore and analyze but cannot modify content (${summary.allowed.length}/${summary.total} tools available)`;
      
      case AgentRole.WRITER:
        return `Execution mode: Can read, create, modify, and organize content efficiently (${summary.allowed.length}/${summary.total} tools available)`;
      
      default:
        return `${summary.allowed.length}/${summary.total} tools available`;
    }
  }
}