/**
 * PageSpace Integration System
 *
 * Provides third-party integration capabilities for PageSpace.
 * Integrations can expose tools to the AI system.
 */

// Types
export type {
  IntegrationDefinition,
  IntegrationCategory,
  IntegrationConfigField,
  IntegrationFieldType,
  IntegrationToolMeta,
  IntegrationToolContext,
  IntegrationToolFactory,
  IntegrationValidator,
  UserIntegrationConfig,
  IntegrationStatus,
  ConfigureIntegrationInput,
  UpdateIntegrationInput,
} from './types';

export {
  configureIntegrationSchema,
  updateIntegrationSchema,
} from './types';

// Registry
export {
  getAllIntegrations,
  getIntegration,
  getIntegrationsByCategory,
  isValidIntegrationId,
  getIntegrationIds,
  getIntegrationToolNames,
  getIntegrationByToolName,
  getAllIntegrationTools,
} from './registry';

// Integration tool loader
export { loadIntegrationTools, getUserIntegrationTools } from './tool-loader';
