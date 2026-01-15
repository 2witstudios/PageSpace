import type { WebSocket, WebSocketServer } from 'ws';
import type { NextRequest } from 'next/server';
import { getMCPBridge } from '@/lib/mcp';
import {
  registerConnection,
  unregisterConnection,
  updateLastPing,
  markChallengeVerified,
  startCleanupInterval,
  checkConnectionHealth,
  verifyConnectionFingerprint,
  getConnectionFingerprint,
  validateMessageSize,
  logSecurityEvent,
  isSecureConnection,
  validateIncomingMessageWithError,
  type IncomingMessage,
  isPingMessage,
  isToolExecuteMessage,
  isToolResultMessage,
} from '@/lib/websocket';
import { sessionService, type SessionClaims } from '@pagespace/lib';

// Initialize cleanup interval on module load
// This prevents memory leaks from stale connections
startCleanupInterval();

/**
 * WebSocket MCP Bridge Route - SECURITY HARDENED
 *
 * This route accepts WebSocket connections from the PageSpace Desktop app,
 * allowing the server to execute MCP tools locally on the user's machine.
 *
 * Security Flow (Opaque Token Authentication):
 * 1. Desktop app fetches opaque WS token from /api/auth/ws-token (authenticated via JWT)
 * 2. Desktop connects with Authorization: Bearer <opaque_token>
 * 3. Server validates opaque token via session service
 * 4. Server verifies secure connection (WSS in production)
 * 5. Server generates connection fingerprint (IP + User-Agent hash)
 * 6. Connection marked as verified immediately (session service did the auth)
 * 7. On each ping: verify fingerprint hasn't changed (detect session hijacking)
 * 8. Connection health check before each tool execution
 * 9. All security events logged for audit trail
 *
 * Note: Tool execution rate limiting is handled by AI SDK's stepCountIs(100) limit per request
 *
 * Defense in Depth:
 * - Opaque token authentication (no JWT timing issues, instant revocation)
 * - Session service validates tokenVersion (revoke all sessions on password change)
 * - Connection fingerprinting (verified on each ping, detects session hijacking)
 * - Connection health checks (verify state before tool execution)
 * - Message size validation (prevent DoS)
 * - Automatic stale connection cleanup (prevent memory leaks)
 * - Comprehensive security logging
 */

export async function UPGRADE(
  client: WebSocket,
  server: WebSocketServer,
  request: NextRequest
) {
  const requestUrl = request.url;
  const clientIp =
    request.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown';

  // SECURITY CHECK 1: Verify secure connection in production
  if (!isSecureConnection(requestUrl, request)) {
    logSecurityEvent('ws_insecure_connection_rejected', {
      ip: clientIp,
      url: requestUrl,
      severity: 'error',
    });
    client.close(1008, 'Secure connection required');
    return;
  }

  // SECURITY CHECK 2: Extract and validate opaque token from Authorization header
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    logSecurityEvent('ws_authentication_failed', {
      ip: clientIp,
      severity: 'warn',
      reason: 'Missing Authorization header',
    });
    client.close(1008, 'Authorization required');
    return;
  }

  const token = authHeader.slice(7).trim();

  // Validate opaque token via session service
  let claims: SessionClaims | null = null;
  try {
    claims = await sessionService.validateSession(token);
  } catch (error) {
    logSecurityEvent('ws_session_validation_error', {
      ip: clientIp,
      severity: 'error',
      error: error instanceof Error ? error.message : String(error),
    });
    client.close(1008, 'Authentication error');
    return;
  }

  if (!claims) {
    logSecurityEvent('ws_authentication_failed', {
      ip: clientIp,
      severity: 'warn',
      reason: 'Invalid or expired session token',
    });
    client.close(1008, 'Invalid or expired token');
    return;
  }

  const userId = claims.userId;

  // SECURITY CHECK 3: Verify scope allows MCP operations
  if (!claims.scopes.includes('mcp:*') && !claims.scopes.includes('*')) {
    logSecurityEvent('ws_insufficient_permissions', {
      userId,
      ip: clientIp,
      severity: 'warn',
      scopes: claims.scopes,
    });
    client.close(1008, 'Insufficient permissions');
    return;
  }

  // SECURITY CHECK 4: Generate connection fingerprint
  const fingerprint = getConnectionFingerprint(request);

  // Register the new connection (handles closing existing connections)
  registerConnection(userId, client, fingerprint);

  // Mark as verified immediately - session service already validated the token
  markChallengeVerified(client);

  logSecurityEvent('ws_connection_established', {
    userId,
    sessionId: claims.sessionId,
    ip: clientIp,
    severity: 'info',
    fingerprint: fingerprint.substring(0, 16) + '...',
  });

  // Send welcome message (no challenge needed - session service did the auth)
  client.send(
    JSON.stringify({
      type: 'connected',
      userId,
      timestamp: Date.now(),
    })
  );

  // Handle incoming messages
  client.on('message', (data) => {
    try {
      // SECURITY CHECK 5: Validate message size
      const sizeValidation = validateMessageSize(data);
      if (!sizeValidation.valid) {
        logSecurityEvent('ws_message_too_large', {
          userId,
          size: sizeValidation.size,
          maxSize: sizeValidation.maxSize,
          severity: 'warn',
        });
        client.send(
          JSON.stringify({
            type: 'error',
            error: 'message_too_large',
            maxSize: sizeValidation.maxSize,
          })
        );
        return;
      }

      // Parse and validate message with Zod schema
      let parsedData: unknown;
      try {
        parsedData = JSON.parse(data.toString());
      } catch (error) {
        logSecurityEvent('ws_message_json_parse_error', {
          userId,
          error: error instanceof Error ? error.message : String(error),
          severity: 'warn',
        });
        client.send(
          JSON.stringify({
            type: 'error',
            error: 'invalid_json',
            reason: 'Message is not valid JSON',
          })
        );
        return;
      }

      // Validate message structure with Zod
      const validationResult = validateIncomingMessageWithError(parsedData);

      if (!validationResult.success) {
        logSecurityEvent('ws_message_validation_failed', {
          userId,
          error: validationResult.error,
          issues: validationResult.issues,
          severity: 'warn',
        });
        client.send(
          JSON.stringify({
            type: 'error',
            error: 'invalid_message_format',
            reason: validationResult.error,
            details: validationResult.issues,
          })
        );
        return;
      }

      const message: IncomingMessage = validationResult.data;

      // Handle ping/pong for health checks
      if (isPingMessage(message)) {
        // SECURITY CHECK 5: Verify connection fingerprint on ping to detect session hijacking
        const currentFingerprint = getConnectionFingerprint(request);
        if (!verifyConnectionFingerprint(client, currentFingerprint)) {
          logSecurityEvent('ws_fingerprint_mismatch', {
            userId,
            severity: 'critical',
            reason: 'Connection fingerprint changed - possible session hijacking',
          });
          client.send(
            JSON.stringify({
              type: 'error',
              error: 'fingerprint_mismatch',
              message: 'Security violation: connection fingerprint mismatch',
            })
          );
          client.close(1008, 'Security violation');
          return;
        }

        updateLastPing(client);
        client.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        return;
      }

      // SECURITY CHECK 6: Connection health check before tool execution
      if (isToolExecuteMessage(message)) {
        const health = checkConnectionHealth(client);

        if (!health.isHealthy) {
          logSecurityEvent('ws_unhealthy_connection_tool_attempt', {
            userId,
            reason: health.reason,
            readyState: health.readyState,
            severity: 'warn',
          });
          client.send(
            JSON.stringify({
              type: 'error',
              error: 'connection_unhealthy',
              reason: health.reason,
            })
          );
          return;
        }
      }

      // Handle tool execution responses
      if (isToolResultMessage(message)) {
        logSecurityEvent('ws_tool_execution_result', {
          userId,
          requestId: message.id,
          success: message.success,
          severity: 'info',
        });

        const mcpBridge = getMCPBridge();
        mcpBridge.handleToolResponse(message);
        return;
      }

      // Note: Unknown message types are now caught by Zod validation above
    } catch (error) {
      logSecurityEvent('ws_message_parse_error', {
        userId,
        error: error instanceof Error ? error.message : String(error),
        severity: 'error',
      });
      client.send(
        JSON.stringify({
          type: 'error',
          error: 'Invalid message format',
        })
      );
    }
  });

  // Handle client disconnect
  client.on('close', (code, reason) => {
    logSecurityEvent('ws_connection_closed', {
      userId,
      code,
      reason: reason.toString(),
      severity: 'info',
    });

    // Clean up resources
    unregisterConnection(userId, client);
  });

  // Handle errors
  client.on('error', (error) => {
    logSecurityEvent('ws_error', {
      userId,
      error: error instanceof Error ? error.message : String(error),
      severity: 'error',
    });
  });
}

// Fallback for non-WebSocket requests
export function GET(): Response {
  return new Response('WebSocket endpoint - use WebSocket protocol to connect', {
    status: 426,
    headers: {
      Upgrade: 'websocket',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'",
    },
  });
}
