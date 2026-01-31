/**
 * @module lib/ai/core
 * @description Core AI utilities shared by both Global AI and Page Agents
 *
 * This module contains the foundational infrastructure for PageSpace's AI systems:
 * - Provider factory for AI model connections
 * - Message utilities for conversation handling
 * - System prompt building
 * - Tool filtering and capabilities
 */

// Provider & Model
export * from './provider-factory';
export * from './ai-providers-config';
export * from './model-capabilities';

// Message & Conversation
export * from './message-utils';
export * from './conversation-state';

// System Prompts
export * from './system-prompt';
export * from './inline-instructions';
export * from './mention-processor';
export * from './timestamp-utils';
export * from './agent-awareness';
export * from './page-tree-context';

// Tools
export * from './ai-tools';
export * from './tool-filtering';
export * from './mcp-tool-converter';

// Utilities
export * from './ai-utils';
export * from './schema-introspection';
export * from './complete-request-builder';

// Stream Abort (server-side registry)
export * from './stream-abort-registry';

// Stream Abort (client-side)
export {
  abortActiveStream,
  createStreamTrackingFetch,
  setActiveStreamId,
  getActiveStreamId,
  clearActiveStreamId,
  handleStreamStartMessage,
} from './stream-abort-client';

// Types
export * from './types';
