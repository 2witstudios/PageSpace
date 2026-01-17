/**
 * PageSpace Integration System - Type Definitions
 *
 * This module defines the types for third-party integrations that can be
 * configured by users and expose tools to the AI system.
 */

import { z } from 'zod';
import type { Tool } from 'ai';

/**
 * Configuration field types for integration setup UI
 */
export type IntegrationFieldType = 'text' | 'password' | 'url' | 'select' | 'boolean';

/**
 * A configuration field required by an integration
 */
export interface IntegrationConfigField {
  /** Unique field identifier (used as key in config object) */
  key: string;
  /** Display label for the field */
  label: string;
  /** Description/help text */
  description: string;
  /** Field type determines UI component */
  type: IntegrationFieldType;
  /** Whether this field is required */
  required: boolean;
  /** Default value */
  defaultValue?: string | boolean;
  /** For 'select' type - available options */
  options?: Array<{ value: string; label: string }>;
  /** For 'url' type - placeholder */
  placeholder?: string;
  /** For 'password' type - whether to encrypt in DB (always true for API keys) */
  encrypt?: boolean;
}

/**
 * Metadata about a tool provided by an integration
 */
export interface IntegrationToolMeta {
  /** Tool name (unique across all integrations) */
  name: string;
  /** Human-readable display name */
  displayName: string;
  /** Short description for UI */
  description: string;
  /** Whether this tool performs write operations */
  isWriteTool?: boolean;
  /** Tags for categorization */
  tags?: string[];
}

/**
 * Context passed to integration tool factories
 */
export interface IntegrationToolContext {
  /** User's stored configuration for this integration */
  config: Record<string, unknown>;
  /** Decrypted API key (if integration requires one) */
  apiKey?: string;
  /** User ID for attribution */
  userId: string;
}

/**
 * Tool factory function - creates AI tools from integration config
 */
export type IntegrationToolFactory = (
  context: IntegrationToolContext
) => Record<string, Tool>;

/**
 * Validation function for integration credentials
 */
export type IntegrationValidator = (
  config: Record<string, unknown>,
  apiKey?: string
) => Promise<{ valid: boolean; message: string }>;

/**
 * Definition of an integration available in PageSpace
 */
export interface IntegrationDefinition {
  /** Unique identifier (e.g., 'apify', 'zapier') */
  id: string;
  /** Display name */
  name: string;
  /** Full description */
  description: string;
  /** Short tagline for cards/lists */
  tagline: string;
  /** Icon name (from lucide-react) or URL */
  icon: string;
  /** Category for grouping in UI */
  category: IntegrationCategory;
  /** Documentation URL */
  docsUrl?: string;
  /** Whether this integration requires an API key */
  requiresApiKey: boolean;
  /** API key field label (default: "API Key") */
  apiKeyLabel?: string;
  /** API key field description/help */
  apiKeyDescription?: string;
  /** Additional configuration fields beyond API key */
  configFields: IntegrationConfigField[];
  /** Tools provided by this integration */
  tools: IntegrationToolMeta[];
  /** Factory function to create AI tools */
  createTools: IntegrationToolFactory;
  /** Validation function for testing credentials */
  validate: IntegrationValidator;
}

/**
 * Categories for grouping integrations in UI
 */
export type IntegrationCategory =
  | 'automation'    // Workflow automation (Zapier, Make)
  | 'data'          // Data extraction/processing (Apify, Firecrawl)
  | 'communication' // Messaging/notifications (Slack, Discord)
  | 'storage'       // Cloud storage (S3, GCS)
  | 'ai'            // AI services (external AI providers)
  | 'development'   // Developer tools (GitHub, GitLab)
  | 'other';        // Miscellaneous

/**
 * User's configured integration (matches DB schema)
 */
export interface UserIntegrationConfig {
  id: string;
  integrationId: string;
  name?: string;
  enabled: boolean;
  config: Record<string, unknown>;
  enabledTools: string[] | null;
  lastValidatedAt?: Date;
  validationStatus?: 'valid' | 'invalid' | 'unknown';
  validationMessage?: string;
}

/**
 * Integration status for display in UI
 */
export interface IntegrationStatus {
  definition: IntegrationDefinition;
  userConfig?: UserIntegrationConfig;
  isConfigured: boolean;
  isEnabled: boolean;
  availableTools: IntegrationToolMeta[];
  enabledTools: IntegrationToolMeta[];
}

/**
 * Zod schemas for API validation
 */
export const configureIntegrationSchema = z.object({
  integrationId: z.string().min(1),
  apiKey: z.string().optional(),
  config: z.record(z.unknown()).optional(),
  enabledTools: z.array(z.string()).nullable().optional(),
});

export const updateIntegrationSchema = z.object({
  enabled: z.boolean().optional(),
  apiKey: z.string().optional(),
  config: z.record(z.unknown()).optional(),
  enabledTools: z.array(z.string()).nullable().optional(),
});

export type ConfigureIntegrationInput = z.infer<typeof configureIntegrationSchema>;
export type UpdateIntegrationInput = z.infer<typeof updateIntegrationSchema>;
