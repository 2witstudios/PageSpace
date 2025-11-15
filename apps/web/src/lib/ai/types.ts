/**
 * PageSpace AI Tools - Internal AI SDK tool implementations
 * These types are shared across AI tools.
 */

import { ModelCapabilities } from './model-capabilities';

export interface ToolExecutionContext {
  userId: string;
  conversationId?: string;
  aiOperationId?: string; // Link to AI operation for audit tracking
  locationContext?: {
    currentPage?: {
      id: string;
      title: string;
      type: string;
      path: string;
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