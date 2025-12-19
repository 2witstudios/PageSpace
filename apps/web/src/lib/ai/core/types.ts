/**
 * PageSpace AI Tools - Internal AI SDK tool implementations
 * These types are shared across AI tools.
 */

import { ModelCapabilities } from './model-capabilities';

export interface ToolExecutionContext {
  userId: string;
  conversationId?: string;
  // AI attribution for activity logging
  aiProvider?: string;
  aiModel?: string;
  locationContext?: {
    currentPage?: {
      id: string;
      title: string;
      type: string;
      path: string;
      isTaskLinked?: boolean;
    };
    currentDrive?: {
      id: string;
      name: string;
      slug: string;
    };
    breadcrumbs?: string[];
  };
  modelCapabilities?: ModelCapabilities;
}