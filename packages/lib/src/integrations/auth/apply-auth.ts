/**
 * Pure Auth Function
 *
 * Builds authentication headers and query params from credentials
 * based on the configured auth method.
 *
 * This is a PURE function - no side effects, deterministic output.
 */

import type { AuthMethod, AuthResult } from '../types';

/**
 * Apply authentication to a request by building headers and query params.
 *
 * @param credentials - Key-value pairs of credential data (decrypted)
 * @param authMethod - The authentication method configuration
 * @returns Headers and query params to add to the request
 */
export const applyAuth = (
  credentials: Record<string, string>,
  authMethod: AuthMethod
): AuthResult => {
  const headers: Record<string, string> = {};
  const queryParams: Record<string, string> = {};

  switch (authMethod.type) {
    case 'bearer_token': {
      const { headerName = 'Authorization', prefix = 'Bearer ' } = authMethod.config;
      const token = credentials.token;
      if (token) {
        headers[headerName] = `${prefix}${token}`;
      }
      break;
    }

    case 'api_key': {
      const { placement, paramName, prefix = '' } = authMethod.config;
      const apiKey = credentials.apiKey;
      if (apiKey) {
        const value = `${prefix}${apiKey}`;

        if (placement === 'header') {
          headers[paramName] = value;
        } else if (placement === 'query') {
          queryParams[paramName] = value;
        }
      }
      // 'body' placement is handled during body construction, not here
      break;
    }

    case 'basic_auth': {
      const { usernameField, passwordField } = authMethod.config;
      const username = credentials[usernameField];
      const password = credentials[passwordField];
      if (username !== undefined && password !== undefined) {
        const encoded = btoa(`${username}:${password}`);
        headers['Authorization'] = `Basic ${encoded}`;
      }
      break;
    }

    case 'oauth2': {
      const { tokenPlacement = 'header', tokenPrefix = 'Bearer ' } = authMethod.config;
      const accessToken = credentials.accessToken;
      if (accessToken) {
        if (tokenPlacement === 'header') {
          headers['Authorization'] = `${tokenPrefix}${accessToken}`;
        } else if (tokenPlacement === 'query') {
          queryParams['access_token'] = accessToken;
        }
      }
      break;
    }

    case 'custom_header': {
      for (const headerConfig of authMethod.config.headers) {
        const { name, valueFrom, credentialKey, staticValue } = headerConfig;

        if (valueFrom === 'credential' && credentialKey) {
          const value = credentials[credentialKey];
          if (value) {
            headers[name] = value;
          }
        } else if (valueFrom === 'static' && staticValue !== undefined) {
          headers[name] = staticValue;
        }
      }
      break;
    }

    case 'none':
      // No authentication needed
      break;
  }

  return { headers, queryParams };
};
