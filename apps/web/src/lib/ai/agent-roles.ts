/**
 * Agent Role System for PageSpace AI
 * 
 * Defines three distinct AI agent roles with different permissions and behaviors:
 * - PARTNER: General conversational AI (balanced)
 * - PLANNER: Strategic planning (read-only)
 * - WRITER: Execution focused (action-oriented)
 */

export enum AgentRole {
  PARTNER = 'PARTNER',
  PLANNER = 'PLANNER',
  WRITER = 'WRITER'
}

export interface RolePermissions {
  canRead: boolean;
  canWrite: boolean;
  canDelete: boolean;
  requiresConfirmation: boolean;
  allowedOperations: string[];
  description: string;
}

export const ROLE_PERMISSIONS: Record<AgentRole, RolePermissions> = {
  [AgentRole.PARTNER]: {
    canRead: true,
    canWrite: true,
    canDelete: true,
    requiresConfirmation: true,
    allowedOperations: ['read', 'write', 'create', 'update', 'delete', 'organize'],
    description: 'Collaborative AI partner with balanced capabilities'
  },
  [AgentRole.PLANNER]: {
    canRead: true,
    canWrite: false,
    canDelete: false,
    requiresConfirmation: false,
    allowedOperations: ['read', 'analyze', 'plan', 'explore'],
    description: 'Strategic planning assistant (read-only)'
  },
  [AgentRole.WRITER]: {
    canRead: true,
    canWrite: true,
    canDelete: true,
    requiresConfirmation: false,
    allowedOperations: ['read', 'write', 'create', 'update', 'delete', 'execute'],
    description: 'Execution-focused assistant with minimal conversation'
  }
};

export interface RoleMetadata {
  icon: string;
  label: string;
  shortDescription: string;
  primaryUseCase: string;
  workflow: string[];
}

export const ROLE_METADATA: Record<AgentRole, RoleMetadata> = {
  [AgentRole.PARTNER]: {
    icon: '',
    label: 'Partner',
    shortDescription: 'Conversational and collaborative',
    primaryUseCase: 'General assistance, exploration, and learning',
    workflow: [
      'Engage in natural conversation',
      'Explore and understand context',
      'Ask before making significant changes',
      'Provide explanations and suggestions'
    ]
  },
  [AgentRole.PLANNER]: {
    icon: '',
    label: 'Planner',
    shortDescription: 'Strategic planning (read-only)',
    primaryUseCase: 'Creating detailed plans without execution',
    workflow: [
      'Analyze current state thoroughly',
      'Ask clarifying questions',
      'Create comprehensive plans',
      'Identify potential issues and solutions'
    ]
  },
  [AgentRole.WRITER]: {
    icon: '',
    label: 'Writer',
    shortDescription: 'Efficient task execution',
    primaryUseCase: 'Executing plans and bulk operations',
    workflow: [
      'Execute requested actions immediately',
      'Confirm completion briefly',
      'Move to next task efficiently',
      'Minimal conversation unless needed'
    ]
  }
};

/**
 * Utility functions for working with agent roles
 */
export class AgentRoleUtils {
  /**
   * Check if a role has a specific permission
   */
  static hasPermission(role: AgentRole, operation: string): boolean {
    const permissions = ROLE_PERMISSIONS[role];
    return permissions.allowedOperations.includes(operation);
  }

  /**
   * Get the default role for new chats
   */
  static getDefaultRole(): AgentRole {
    return AgentRole.PARTNER;
  }

  /**
   * Validate if a role string is valid
   */
  static isValidRole(role: string): role is AgentRole {
    return Object.values(AgentRole).includes(role as AgentRole);
  }

  /**
   * Get role from string with fallback to default
   */
  static getRoleFromString(roleString?: string): AgentRole {
    if (roleString && this.isValidRole(roleString)) {
      return roleString as AgentRole;
    }
    return this.getDefaultRole();
  }

  /**
   * Check if role transition is allowed
   */
  static canTransitionTo(): boolean {
    // All role transitions are allowed for now
    // Can add business logic here if needed (e.g., admin-only transitions)
    return true;
  }

  /**
   * Get role-specific settings for UI
   */
  static getRoleDisplayInfo(role: AgentRole) {
    const permissions = ROLE_PERMISSIONS[role];
    const metadata = ROLE_METADATA[role];
    
    return {
      ...metadata,
      permissions,
      canModify: permissions.canWrite,
      isReadOnly: !permissions.canWrite && !permissions.canDelete,
      warningLevel: permissions.canDelete ? 'high' : permissions.canWrite ? 'medium' : 'low'
    };
  }
}

/**
 * Type for role context in API requests
 */
export interface RoleContext {
  role: AgentRole;
  permissions: RolePermissions;
  metadata: RoleMetadata;
  transitionedAt?: Date;
  previousRole?: AgentRole;
}

/**
 * Create a role context object
 */
export function createRoleContext(
  role: AgentRole, 
  previousRole?: AgentRole
): RoleContext {
  return {
    role,
    permissions: ROLE_PERMISSIONS[role],
    metadata: ROLE_METADATA[role],
    transitionedAt: new Date(),
    previousRole
  };
}