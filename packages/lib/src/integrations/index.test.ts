import { describe, it, expect } from 'vitest';
import * as integrationTypes from './types';
import * as applyAuth from './auth/apply-auth';
import * as isToolAllowed from './validation/is-tool-allowed';
import * as visibility from './validation/visibility';
import * as buildRequest from './execution/build-request';
import * as transformOutput from './execution/transform-output';
import * as calculateLimit from './rate-limit/calculate-limit';
import * as encryptCredentials from './credentials/encrypt-credentials';
import * as integrationRateLimiter from './rate-limit/integration-rate-limiter';
import * as httpExecutor from './execution/http-executor';
import * as executeToolSaga from './saga/execute-tool';
import * as aiSdk from './converter/ai-sdk';
import * as openapi from './converter/openapi';
import * as resolveAgentIntegrations from './resolution/resolve-agent-integrations';
import * as oauthHandler from './oauth/oauth-handler';
import * as oauthState from './oauth/oauth-state';
import * as providerRepository from './repositories/provider-repository';
import * as configRepository from './repositories/config-repository';
import * as connectionRepository from './repositories/connection-repository';
import * as grantRepository from './repositories/grant-repository';
import * as auditRepository from './repositories/audit-repository';
import * as builtinProviders from './providers/builtin-providers';
import { genericWebhookProvider } from './providers/generic-webhook';
import { githubProvider } from './providers/github';
import { notionProvider } from './providers/notion';
import { slackProvider } from './providers/slack';

const integrations = {
  ...integrationTypes,
  ...applyAuth,
  ...isToolAllowed,
  ...visibility,
  ...buildRequest,
  ...transformOutput,
  ...calculateLimit,
  ...encryptCredentials,
  ...integrationRateLimiter,
  ...httpExecutor,
  ...executeToolSaga,
  ...aiSdk,
  ...openapi,
  ...resolveAgentIntegrations,
  ...oauthHandler,
  ...oauthState,
  ...providerRepository,
  ...configRepository,
  ...connectionRepository,
  ...grantRepository,
  ...auditRepository,
  ...builtinProviders,
  genericWebhookProvider,
  githubProvider,
  notionProvider,
  slackProvider,
};

describe('integrations module exports', () => {
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
    'listProvidersForDrive', 'createProvider', 'updateProvider',
    'deleteProvider', 'countProviderConnections', 'seedBuiltinProviders',
    // repositories — config
    'getOrCreateConfig', 'getConfig', 'updateConfig',
    // repositories — connections
    'createConnection', 'getConnectionById', 'getConnectionWithProvider',
    'findUserConnection', 'findDriveConnection', 'updateConnectionStatus',
    'updateConnectionCredentials', 'updateConnectionLastUsed',
    'deleteConnection', 'listUserConnections', 'listDriveConnections',
    // repositories — grants
    'createGrant', 'getGrantById', 'findGrant',
    'listGrantsByAgent', 'listGrantsByConnection', 'updateGrant',
    'deleteGrant', 'deleteGrantsByConnection', 'deleteGrantsByAgent',
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
