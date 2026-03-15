/**
 * @scaffold — barrel export presence check. Will be replaced by
 * behavioural tests once each module has its own dedicated suite.
 */
import { describe, it, expect } from 'vitest';
import * as integrations from './index';

describe('integrations barrel export @scaffold', () => {
  const expectedFunctions = [
    // auth
    'applyAuth',
    // validation
    'isToolAllowed', 'isUserIntegrationVisibleInDrive',
    // execution/build-request
    'buildHttpRequest', 'interpolatePath', 'resolveValue', 'resolveBody',
    // execution/transform-output
    'transformOutput', 'extractPath', 'applyMapping', 'truncateStrings',
    // rate-limit
    'calculateEffectiveRateLimit', 'checkIntegrationRateLimit',
    'resetIntegrationRateLimit', 'checkConnectionRateLimit',
    'checkDriveRateLimit', 'buildRateLimitKey',
    // credentials
    'encryptCredentials', 'decryptCredentials',
    // execution/http-executor
    'executeHttpRequest',
    // saga
    'executeToolSaga', 'createToolExecutor',
    // converter/ai-sdk
    'convertIntegrationToolsToAISDK', 'convertToolSchemaToZod',
    'buildIntegrationToolName', 'parseIntegrationToolName', 'isIntegrationTool',
    // openapi
    'importOpenAPISpec',
    // resolution
    'resolveAgentIntegrations', 'resolveGlobalAssistantIntegrations',
    // oauth
    'buildOAuthAuthorizationUrl', 'exchangeOAuthCode', 'refreshOAuthToken',
    'generatePKCE', 'createSignedState', 'verifySignedState',
    // repositories — providers
    'getProviderById', 'getProviderBySlug', 'listEnabledProviders',
    'createProvider', 'updateProvider', 'deleteProvider',
    // repositories — config
    'getOrCreateConfig', 'getConfig', 'updateConfig',
    // repositories — connections
    'createConnection', 'getConnectionById', 'deleteConnection',
    // repositories — grants
    'createGrant', 'getGrantById', 'deleteGrant',
    // repositories — audit
    'logAuditEntry', 'getAuditLogsByDrive', 'getAuditLogsByConnection',
    'getAuditLogsByDateRange', 'getAuditLogsBySuccess',
    'getAuditLogsByAgent', 'getAuditLogsByTool',
    // providers
    'getBuiltinProvider', 'isBuiltinProvider',
  ] as const;

  const expectedObjects = [
    'INTEGRATION_RATE_LIMITS',
    'DEFAULT_EXECUTE_OPTIONS', 'FAST_EXECUTE_OPTIONS', 'LONG_EXECUTE_OPTIONS',
    'builtinProviders', 'builtinProviderList',
    'genericWebhookProvider', 'githubProvider', 'notionProvider', 'slackProvider',
  ] as const;

  it('exports all expected public functions', () => {
    for (const name of expectedFunctions) {
      expect(integrations).toHaveProperty(name);
      expect(typeof (integrations as Record<string, unknown>)[name]).toBe('function');
    }
  });

  it('exports all expected public objects and constants', () => {
    for (const name of expectedObjects) {
      expect(integrations).toHaveProperty(name);
      expect((integrations as Record<string, unknown>)[name]).not.toBeUndefined();
    }
  });
});
