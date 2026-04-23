import type { WebSocket, WebSocketServer } from 'ws';
import type { NextRequest } from 'next/server';
import { getMCPBridge } from '@/lib/mcp';
import { isFetchBridgeInitialized, getFetchBridge } from '@/lib/fetch-bridge';
import {
  getConnection,
  registerConnection,
  unregisterConnection,
  updateLastPing,
  markChallengeVerified,
  startCleanupInterval,
  checkConnectionHealth,
  verifyConnectionFingerprint,
  getConnectionFingerprint,
  validateMessageSize,
  isSecureConnection,
  validateIncomingMessageWithError,
  type IncomingMessage,
  isPingMessage,
  isToolExecuteMessage,
  isToolResultMessage,
  isFetchResponseStartMessage,
  isFetchResponseChunkMessage,
  isFetchResponseEndMessage,
  isFetchResponseErrorMessage,
} from '@/lib/websocket';
import { sessionService, type SessionClaims } from '@pagespace/lib';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

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

  // SECURITY CHECK 1: Verify secure connection in production
  if (!isSecureConnection(requestUrl, request)) {
    auditRequest(request, {
      eventType: 'security.anomaly.detected',
      resourceType: 'mcp_websocket',
      riskScore: 0.7,
      details: { originalEvent: 'ws_insecure_connection_rejected', url: requestUrl },
    });
    client.close(1008, 'Secure connection required');
    return;
  }

  // SECURITY CHECK 2: Extract and validate opaque token from Authorization header
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    auditRequest(request, {
      eventType: 'auth.login.failure',
      resourceType: 'mcp_websocket',
      riskScore: 0.3,
      details: { originalEvent: 'ws_authentication_failed', reason: 'Missing Authorization header' },
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
    auditRequest(request, {
      eventType: 'auth.login.failure',
      resourceType: 'mcp_websocket',
      riskScore: 0.3,
      details: { originalEvent: 'ws_session_validation_error', error: error instanceof Error ? error.message : String(error) },
    });
    client.close(1008, 'Authentication error');
    return;
  }

  if (!claims) {
    auditRequest(request, {
      eventType: 'auth.login.failure',
      resourceType: 'mcp_websocket',
      riskScore: 0.3,
      details: { originalEvent: 'ws_authentication_failed', reason: 'Invalid or expired session token' },
    });
    client.close(1008, 'Invalid or expired token');
    return;
  }

  const userId = claims.userId;

  // SECURITY CHECK 3: Verify scope allows MCP operations
  if (!claims.scopes.includes('mcp:*') && !claims.scopes.includes('*')) {
    auditRequest(request, {
      eventType: 'authz.access.denied',
      userId,
      resourceType: 'mcp_websocket',
      riskScore: 0.5,
      details: { originalEvent: 'ws_insufficient_permissions', scopes: claims.scopes },
    });
    client.close(1008, 'Insufficient permissions');
    return;
  }

  // SECURITY CHECK 4: Generate connection fingerprint
  const fingerprint = getConnectionFingerprint(request);

  // Register the new connection (handles closing existing connections)
  // Pass sessionExpiresAt to enforce TTL on persistent connections
  // Pass token to enable periodic session revalidation (detects revoked sessions)
  registerConnection(userId, client, fingerprint, claims.sessionId, claims.expiresAt, token);

  // Mark as verified immediately - session service already validated the token
  markChallengeVerified(client);

  // Fingerprint is intentionally NOT embedded in audit details — it is a
  // stable, client-linkable pseudonym (hash of IP+UA) that would persist in
  // the tamper-evident audit chain and resist GDPR erasure requests.
  auditRequest(request, {
    eventType: 'auth.session.created',
    userId,
    sessionId: claims.sessionId,
    resourceType: 'mcp_websocket',
    riskScore: 0,
    details: { originalEvent: 'ws_connection_established' },
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
        auditRequest(request, {
          eventType: 'security.anomaly.detected',
          userId,
          resourceType: 'mcp_websocket',
          riskScore: 0.3,
          details: { originalEvent: 'ws_message_too_large', size: sizeValidation.size, maxSize: sizeValidation.maxSize },
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
        auditRequest(request, {
          eventType: 'security.anomaly.detected',
          userId,
          resourceType: 'mcp_websocket',
          riskScore: 0.3,
          details: { originalEvent: 'ws_message_json_parse_error', error: error instanceof Error ? error.message : String(error) },
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
        auditRequest(request, {
          eventType: 'security.anomaly.detected',
          userId,
          resourceType: 'mcp_websocket',
          riskScore: 0.3,
          details: { originalEvent: 'ws_message_validation_failed', error: validationResult.error, issues: validationResult.issues },
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
        // SECURITY CHECK 6: Verify connection fingerprint on ping to detect session hijacking
        const currentFingerprint = getConnectionFingerprint(request);
        if (!verifyConnectionFingerprint(client, currentFingerprint)) {
          auditRequest(request, {
            eventType: 'security.anomaly.detected',
            userId,
            resourceType: 'mcp_websocket',
            riskScore: 0.7,
            details: { originalEvent: 'ws_fingerprint_mismatch', reason: 'Connection fingerprint changed - possible session hijacking' },
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

      // SECURITY CHECK 7: Connection health check before tool execution
      if (isToolExecuteMessage(message)) {
        const health = checkConnectionHealth(client);

        if (!health.isHealthy) {
          auditRequest(request, {
            eventType: 'security.anomaly.detected',
            userId,
            resourceType: 'mcp_websocket',
            riskScore: 0.5,
            details: { originalEvent: 'ws_unhealthy_connection_tool_attempt', reason: health.reason, readyState: health.readyState },
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

      // Handle tool execution responses (protocol-level ack, not audited)
      if (isToolResultMessage(message)) {
        const mcpBridge = getMCPBridge();
        mcpBridge.handleToolResponse(message);
        return;
      }

      // Handle fetch bridge responses (desktop proxying HTTP for local AI providers)
      // These are protocol-level transport events, not audit events
      if (isFetchBridgeInitialized()) {
        if (isFetchResponseStartMessage(message)) {
          getFetchBridge().handleResponseStart(message);
          return;
        }
        if (isFetchResponseChunkMessage(message)) {
          getFetchBridge().handleResponseChunk(message);
          return;
        }
        if (isFetchResponseEndMessage(message)) {
          getFetchBridge().handleResponseEnd(message);
          return;
        }
        if (isFetchResponseErrorMessage(message)) {
          // Fetch errors are typically network/provider issues, not security events.
          // Log at low risk so they don't inflate anomaly signals.
          auditRequest(request, {
            eventType: 'security.anomaly.detected',
            userId,
            resourceType: 'mcp_websocket',
            riskScore: 0.1,
            details: { originalEvent: 'ws_fetch_response_error', requestId: message.id, error: message.error },
          });
          getFetchBridge().handleResponseError(message);
          return;
        }
      }

      // Note: Unknown message types are now caught by Zod validation above
    } catch (error) {
      auditRequest(request, {
        eventType: 'security.anomaly.detected',
        userId,
        resourceType: 'mcp_websocket',
        riskScore: 0.3,
        details: { originalEvent: 'ws_message_parse_error', error: error instanceof Error ? error.message : String(error) },
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
    // Only audit abnormal closes. Normal closes (1000 = clean, 1001 = going away)
    // are routine transport-level lifecycle events, not security events — auditing
    // them would pollute forensics with noise.
    const isNormalClose = code === 1000 || code === 1001;
    if (!isNormalClose) {
      auditRequest(request, {
        eventType: 'security.anomaly.detected',
        userId,
        resourceType: 'mcp_websocket',
        riskScore: 0.3,
        details: { originalEvent: 'ws_connection_closed', code, reason: reason.toString() },
      });
    }

    // Clean up resources — only cancel fetch-bridge requests if this socket
    // is still the active connection (prevents stale socket from canceling
    // in-flight requests after a reconnect).
    if (isFetchBridgeInitialized() && getConnection(userId) === client) {
      getFetchBridge().cancelUserRequests(userId);
    }
    unregisterConnection(userId, client);
  });

  // Handle errors
  client.on('error', (error) => {
    auditRequest(request, {
      eventType: 'security.anomaly.detected',
      userId,
      resourceType: 'mcp_websocket',
      riskScore: 0.3,
      details: { originalEvent: 'ws_error', error: error instanceof Error ? error.message : String(error) },
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
