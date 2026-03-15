/**
 * Integration Module Barrel Export Tests
 *
 * Verifies that all public API surface is exported correctly.
 */

import { describe, it, expect } from 'vitest';
import * as integrations from './index';

describe('integrations barrel exports', () => {
  it('should export auth functions', () => {
    expect(integrations.applyAuth).toBeDefined();
  });

  it('should export validation functions', () => {
    expect(integrations.isToolAllowed).toBeDefined();
    expect(integrations.isUserIntegrationVisibleInDrive).toBeDefined();
  });

  it('should export execution functions', () => {
    expect(integrations.buildHttpRequest).toBeDefined();
    expect(integrations.interpolatePath).toBeDefined();
    expect(integrations.resolveValue).toBeDefined();
    expect(integrations.resolveBody).toBeDefined();
  });

  it('should export transform functions', () => {
    expect(integrations.transformOutput).toBeDefined();
    expect(integrations.extractPath).toBeDefined();
    expect(integrations.applyMapping).toBeDefined();
    expect(integrations.truncateStrings).toBeDefined();
  });

  it('should export rate limit functions', () => {
    expect(integrations.calculateEffectiveRateLimit).toBeDefined();
    expect(integrations.checkIntegrationRateLimit).toBeDefined();
    expect(integrations.resetIntegrationRateLimit).toBeDefined();
    expect(integrations.checkConnectionRateLimit).toBeDefined();
    expect(integrations.checkDriveRateLimit).toBeDefined();
    expect(integrations.buildRateLimitKey).toBeDefined();
    expect(integrations.INTEGRATION_RATE_LIMITS).toBeDefined();
  });

  it('should export credential functions', () => {
    expect(integrations.encryptCredentials).toBeDefined();
    expect(integrations.decryptCredentials).toBeDefined();
  });

  it('should export HTTP executor', () => {
    expect(integrations.executeHttpRequest).toBeDefined();
    expect(integrations.DEFAULT_EXECUTE_OPTIONS).toBeDefined();
    expect(integrations.FAST_EXECUTE_OPTIONS).toBeDefined();
    expect(integrations.LONG_EXECUTE_OPTIONS).toBeDefined();
  });

  it('should export execution saga', () => {
    expect(integrations.executeToolSaga).toBeDefined();
    expect(integrations.createToolExecutor).toBeDefined();
  });

  it('should export AI SDK converter', () => {
    expect(integrations.convertIntegrationToolsToAISDK).toBeDefined();
    expect(integrations.convertToolSchemaToZod).toBeDefined();
    expect(integrations.buildIntegrationToolName).toBeDefined();
    expect(integrations.parseIntegrationToolName).toBeDefined();
    expect(integrations.isIntegrationTool).toBeDefined();
  });

  it('should export OpenAPI importer', () => {
    expect(integrations.importOpenAPISpec).toBeDefined();
  });

  it('should export agent integration resolution', () => {
    expect(integrations.resolveAgentIntegrations).toBeDefined();
    expect(integrations.resolveGlobalAssistantIntegrations).toBeDefined();
  });

  it('should export OAuth functions', () => {
    expect(integrations.buildOAuthAuthorizationUrl).toBeDefined();
    expect(integrations.exchangeOAuthCode).toBeDefined();
    expect(integrations.refreshOAuthToken).toBeDefined();
    expect(integrations.generatePKCE).toBeDefined();
    expect(integrations.createSignedState).toBeDefined();
    expect(integrations.verifySignedState).toBeDefined();
  });

  it('should export repository functions', () => {
    expect(integrations.getProviderById).toBeDefined();
    expect(integrations.getProviderBySlug).toBeDefined();
    expect(integrations.listEnabledProviders).toBeDefined();
    expect(integrations.createProvider).toBeDefined();
    expect(integrations.updateProvider).toBeDefined();
    expect(integrations.deleteProvider).toBeDefined();
    expect(integrations.getOrCreateConfig).toBeDefined();
    expect(integrations.getConfig).toBeDefined();
    expect(integrations.updateConfig).toBeDefined();
    expect(integrations.createConnection).toBeDefined();
    expect(integrations.getConnectionById).toBeDefined();
    expect(integrations.deleteConnection).toBeDefined();
    expect(integrations.createGrant).toBeDefined();
    expect(integrations.getGrantById).toBeDefined();
    expect(integrations.deleteGrant).toBeDefined();
    expect(integrations.logAuditEntry).toBeDefined();
    expect(integrations.getAuditLogsByDrive).toBeDefined();
    expect(integrations.getAuditLogsByConnection).toBeDefined();
    expect(integrations.getAuditLogsByDateRange).toBeDefined();
    expect(integrations.getAuditLogsBySuccess).toBeDefined();
    expect(integrations.getAuditLogsByAgent).toBeDefined();
    expect(integrations.getAuditLogsByTool).toBeDefined();
  });

  it('should export built-in provider adapters', () => {
    expect(integrations.builtinProviders).toBeDefined();
    expect(integrations.builtinProviderList).toBeDefined();
    expect(integrations.getBuiltinProvider).toBeDefined();
    expect(integrations.isBuiltinProvider).toBeDefined();
    expect(integrations.genericWebhookProvider).toBeDefined();
    expect(integrations.githubProvider).toBeDefined();
    expect(integrations.notionProvider).toBeDefined();
    expect(integrations.slackProvider).toBeDefined();
  });
});
