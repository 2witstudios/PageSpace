/**
 * Pure Auth Function Tests
 *
 * Tests for applyAuth - a pure function that builds auth headers/params
 * from credentials and auth method configuration.
 */

import { describe, it, expect } from 'vitest';
import { applyAuth } from './apply-auth';
import type { AuthMethod } from '../types';

describe('applyAuth', () => {
  describe('bearer_token auth', () => {
    it('given bearer_token auth with default config, should add Authorization header with Bearer prefix', () => {
      const credentials = { token: 'abc123' };
      const authMethod: AuthMethod = {
        type: 'bearer_token',
        config: {},
      };

      const result = applyAuth(credentials, authMethod);

      expect(result).toEqual({
        headers: { Authorization: 'Bearer abc123' },
        queryParams: {},
      });
    });

    it('given bearer_token auth with custom prefix, should use the specified prefix', () => {
      const credentials = { token: 'xyz789' };
      const authMethod: AuthMethod = {
        type: 'bearer_token',
        config: { prefix: 'Token ' },
      };

      const result = applyAuth(credentials, authMethod);

      expect(result).toEqual({
        headers: { Authorization: 'Token xyz789' },
        queryParams: {},
      });
    });

    it('given bearer_token auth with custom header name, should use specified header', () => {
      const credentials = { token: 'custom123' };
      const authMethod: AuthMethod = {
        type: 'bearer_token',
        config: { headerName: 'X-Auth-Token', prefix: '' },
      };

      const result = applyAuth(credentials, authMethod);

      expect(result).toEqual({
        headers: { 'X-Auth-Token': 'custom123' },
        queryParams: {},
      });
    });
  });

  describe('api_key auth', () => {
    it('given api_key auth with header placement, should add the key to specified header', () => {
      const credentials = { apiKey: 'my-api-key' };
      const authMethod: AuthMethod = {
        type: 'api_key',
        config: {
          placement: 'header',
          paramName: 'X-API-Key',
        },
      };

      const result = applyAuth(credentials, authMethod);

      expect(result).toEqual({
        headers: { 'X-API-Key': 'my-api-key' },
        queryParams: {},
      });
    });

    it('given api_key auth with header placement and prefix, should include prefix', () => {
      const credentials = { apiKey: 'secret-key' };
      const authMethod: AuthMethod = {
        type: 'api_key',
        config: {
          placement: 'header',
          paramName: 'Authorization',
          prefix: 'Api-Key ',
        },
      };

      const result = applyAuth(credentials, authMethod);

      expect(result).toEqual({
        headers: { Authorization: 'Api-Key secret-key' },
        queryParams: {},
      });
    });

    it('given api_key auth with query placement, should add the key to URL query params', () => {
      const credentials = { apiKey: 'query-key-123' };
      const authMethod: AuthMethod = {
        type: 'api_key',
        config: {
          placement: 'query',
          paramName: 'api_key',
        },
      };

      const result = applyAuth(credentials, authMethod);

      expect(result).toEqual({
        headers: {},
        queryParams: { api_key: 'query-key-123' },
      });
    });

    it('given api_key auth with query placement and prefix, should include prefix in value', () => {
      const credentials = { apiKey: 'prefixed-key' };
      const authMethod: AuthMethod = {
        type: 'api_key',
        config: {
          placement: 'query',
          paramName: 'key',
          prefix: 'pk_',
        },
      };

      const result = applyAuth(credentials, authMethod);

      expect(result).toEqual({
        headers: {},
        queryParams: { key: 'pk_prefixed-key' },
      });
    });
  });

  describe('basic_auth', () => {
    it('given basic_auth config, should create Base64-encoded Authorization header', () => {
      const credentials = { username: 'user', password: 'pass' };
      const authMethod: AuthMethod = {
        type: 'basic_auth',
        config: {
          usernameField: 'username',
          passwordField: 'password',
        },
      };

      const result = applyAuth(credentials, authMethod);

      // btoa('user:pass') = 'dXNlcjpwYXNz'
      expect(result).toEqual({
        headers: { Authorization: 'Basic dXNlcjpwYXNz' },
        queryParams: {},
      });
    });

    it('given basic_auth with custom field names, should use correct credential fields', () => {
      const credentials = { user: 'admin', secret: 'admin123' };
      const authMethod: AuthMethod = {
        type: 'basic_auth',
        config: {
          usernameField: 'user',
          passwordField: 'secret',
        },
      };

      const result = applyAuth(credentials, authMethod);

      // btoa('admin:admin123') = 'YWRtaW46YWRtaW4xMjM='
      expect(result).toEqual({
        headers: { Authorization: 'Basic YWRtaW46YWRtaW4xMjM=' },
        queryParams: {},
      });
    });

    it('given basic_auth with empty password, should encode correctly', () => {
      const credentials = { username: 'apikey', password: '' };
      const authMethod: AuthMethod = {
        type: 'basic_auth',
        config: {
          usernameField: 'username',
          passwordField: 'password',
        },
      };

      const result = applyAuth(credentials, authMethod);

      // btoa('apikey:') = 'YXBpa2V5Og=='
      expect(result).toEqual({
        headers: { Authorization: 'Basic YXBpa2V5Og==' },
        queryParams: {},
      });
    });
  });

  describe('oauth2 auth', () => {
    it('given oauth2 auth, should add access token with default Bearer prefix', () => {
      const credentials = { accessToken: 'oauth-access-token' };
      const authMethod: AuthMethod = {
        type: 'oauth2',
        config: {
          authorizationUrl: 'https://example.com/oauth/authorize',
          tokenUrl: 'https://example.com/oauth/token',
          scopes: ['read', 'write'],
        },
      };

      const result = applyAuth(credentials, authMethod);

      expect(result).toEqual({
        headers: { Authorization: 'Bearer oauth-access-token' },
        queryParams: {},
      });
    });

    it('given oauth2 auth with custom prefix, should use specified prefix', () => {
      const credentials = { accessToken: 'custom-oauth-token' };
      const authMethod: AuthMethod = {
        type: 'oauth2',
        config: {
          authorizationUrl: 'https://example.com/oauth/authorize',
          tokenUrl: 'https://example.com/oauth/token',
          scopes: [],
          tokenPrefix: 'token ',
        },
      };

      const result = applyAuth(credentials, authMethod);

      expect(result).toEqual({
        headers: { Authorization: 'token custom-oauth-token' },
        queryParams: {},
      });
    });

    it('given oauth2 auth with query placement, should add token to query params', () => {
      const credentials = { accessToken: 'query-oauth-token' };
      const authMethod: AuthMethod = {
        type: 'oauth2',
        config: {
          authorizationUrl: 'https://example.com/oauth/authorize',
          tokenUrl: 'https://example.com/oauth/token',
          scopes: [],
          tokenPlacement: 'query',
        },
      };

      const result = applyAuth(credentials, authMethod);

      expect(result).toEqual({
        headers: {},
        queryParams: { access_token: 'query-oauth-token' },
      });
    });
  });

  describe('custom_header auth', () => {
    it('given custom_header auth with credential value, should add header from credentials', () => {
      const credentials = { myApiKey: 'secret-api-key' };
      const authMethod: AuthMethod = {
        type: 'custom_header',
        config: {
          headers: [
            { name: 'X-Custom-Auth', valueFrom: 'credential', credentialKey: 'myApiKey' },
          ],
        },
      };

      const result = applyAuth(credentials, authMethod);

      expect(result).toEqual({
        headers: { 'X-Custom-Auth': 'secret-api-key' },
        queryParams: {},
      });
    });

    it('given custom_header auth with static value, should add header with static value', () => {
      const credentials = {};
      const authMethod: AuthMethod = {
        type: 'custom_header',
        config: {
          headers: [
            { name: 'X-App-Version', valueFrom: 'static', staticValue: '1.0.0' },
          ],
        },
      };

      const result = applyAuth(credentials, authMethod);

      expect(result).toEqual({
        headers: { 'X-App-Version': '1.0.0' },
        queryParams: {},
      });
    });

    it('given custom_header auth with multiple headers, should add all headers', () => {
      const credentials = { token: 'my-token', orgId: 'org-123' };
      const authMethod: AuthMethod = {
        type: 'custom_header',
        config: {
          headers: [
            { name: 'X-Auth-Token', valueFrom: 'credential', credentialKey: 'token' },
            { name: 'X-Organization-ID', valueFrom: 'credential', credentialKey: 'orgId' },
            { name: 'X-Client', valueFrom: 'static', staticValue: 'PageSpace' },
          ],
        },
      };

      const result = applyAuth(credentials, authMethod);

      expect(result).toEqual({
        headers: {
          'X-Auth-Token': 'my-token',
          'X-Organization-ID': 'org-123',
          'X-Client': 'PageSpace',
        },
        queryParams: {},
      });
    });
  });

  describe('none auth', () => {
    it('given none auth, should return empty headers and params', () => {
      const credentials = { anyKey: 'anyValue' };
      const authMethod: AuthMethod = { type: 'none' };

      const result = applyAuth(credentials, authMethod);

      expect(result).toEqual({
        headers: {},
        queryParams: {},
      });
    });
  });

  describe('edge cases', () => {
    it('given missing credential key, should handle gracefully with empty string', () => {
      const credentials = {};
      const authMethod: AuthMethod = {
        type: 'bearer_token',
        config: {},
      };

      const result = applyAuth(credentials, authMethod);

      expect(result).toEqual({
        headers: { Authorization: 'Bearer ' },
        queryParams: {},
      });
    });
  });
});
