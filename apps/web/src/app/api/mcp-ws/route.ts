import type { WebSocket, WebSocketServer } from 'ws';
import type { NextRequest } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { getMCPBridge } from '@/lib/mcp-bridge';
import {
  registerConnection,
  unregisterConnection,
  updateLastPing,
  markChallengeVerified,
  isChallengeVerified,
  startCleanupInterval,
  checkConnectionHealth,
  setJWTExpiryTimer,
  verifyConnectionFingerprint,
} from '@/lib/ws-connections';
import {
  generateChallenge,
  verifyChallengeResponse,
  clearChallenge,
  getConnectionFingerprint,
  validateMessageSize,
  logSecurityEvent,
  isSecureConnection,
  getSessionIdFromPayload,
} from '@/lib/ws-security';
import { decodeToken } from '@pagespace/lib/server';
import {
  validateIncomingMessageWithError,
  type IncomingMessage,
  isPingMessage,
  isChallengeResponseMessage,
  isToolExecuteMessage,
  isToolResultMessage,
} from '@/lib/ws-message-schemas';

// Initialize cleanup interval on module load
// This prevents memory leaks from stale connections
startCleanupInterval();

/**
 * WebSocket MCP Bridge Route - SECURITY HARDENED
 *
 * This route accepts WebSocket connections from the PageSpace Desktop app,
 * allowing the server to execute MCP tools locally on the user's machine.
 *
 * Security Flow:
 * 1. Desktop app connects with JWT in cookie (httpOnly, secure)
 * 2. Server validates JWT signature and expiration
 * 3. Server verifies secure connection (WSS in production)
 * 4. Server generates connection fingerprint (IP + User-Agent hash)
 * 5. Server extracts JWT expiry and sets automatic disconnection timer
 * 6. Server sends cryptographic challenge to client
 * 7. Client responds with SHA256(challenge + userId + sessionId)
 * 8. Server verifies challenge response (max 3 attempts, 30s expiration)
 * 9. Connection marked as verified, tool execution enabled
 * 10. On each ping: verify fingerprint hasn't changed (detect session hijacking)
 * 11. Connection health check before each tool execution
 * 12. All security events logged for audit trail
 *
 * Note: Tool execution rate limiting is handled by AI SDK's stepCountIs(100) limit per request
 *
 * Defense in Depth:
 * - JWT authentication (initial + automatic expiry enforcement)
 * - Challenge-response verification (post-connection)
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

  // SECURITY CHECK 2: Verify JWT authentication
  const user = await verifyAuth(request);

  if (!user) {
    logSecurityEvent('ws_authentication_failed', {
      ip: clientIp,
      severity: 'warn',
      reason: 'Invalid or missing JWT',
    });
    client.close(1008, 'Unauthorized');
    return;
  }

  const userId = user.id;

  // SECURITY CHECK 3: Generate connection fingerprint
  const fingerprint = getConnectionFingerprint(request);

  // Register the new connection (handles closing existing connections)
  registerConnection(userId, client, fingerprint);

  logSecurityEvent('ws_connection_established', {
    userId,
    ip: clientIp,
    severity: 'info',
    fingerprint: fingerprint.substring(0, 16) + '...', // Partial for privacy
  });

  // SECURITY CHECK 4: Extract JWT and set expiry timer for automatic disconnection
  const cookieHeader = request.headers.get('cookie');
  const accessToken = cookieHeader
    ?.split(';')
    .find((c) => c.trim().startsWith('accessToken='))
    ?.split('=')[1];

  if (accessToken) {
    const payload = await decodeToken(accessToken);
    if (payload?.exp) {
      const expiresAt = new Date(payload.exp * 1000); // JWT exp is in seconds
      setJWTExpiryTimer(client, expiresAt, () => {
        logSecurityEvent('ws_jwt_expired', {
          userId,
          expiresAt: expiresAt.toISOString(),
          severity: 'info',
        });
      });

      logSecurityEvent('ws_jwt_expiry_timer_set', {
        userId,
        expiresAt: expiresAt.toISOString(),
        severity: 'info',
      });
    }
  }

  // SECURITY CHECK 5: Generate challenge for post-connection verification
  const challenge = generateChallenge(userId);

  // Send challenge to client
  client.send(
    JSON.stringify({
      type: 'challenge',
      challenge,
      expiresIn: 30000, // 30 seconds
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

      // Handle challenge response (must be first message after connection)
      if (isChallengeResponseMessage(message)) {
        // Get session ID from JWT for challenge verification
        const cookieHeader = request.headers.get('cookie');
        const accessToken = cookieHeader
          ?.split(';')
          .find((c) => c.trim().startsWith('accessToken='))
          ?.split('=')[1];

        if (!accessToken) {
          logSecurityEvent('ws_challenge_failed_no_token', {
            userId,
            severity: 'error',
          });
          client.close(1008, 'Session expired');
          return;
        }

        // Decode JWT to get session ID
        decodeToken(accessToken).then((payload) => {
          if (!payload) {
            logSecurityEvent('ws_challenge_failed_invalid_token', {
              userId,
              severity: 'error',
            });
            client.close(1008, 'Session expired');
            return;
          }

          const sessionId = getSessionIdFromPayload(payload);

          // Verify challenge response
          const verification = verifyChallengeResponse(
            userId,
            message.response,
            sessionId
          );

          if (!verification.valid) {
            logSecurityEvent('ws_challenge_verification_failed', {
              userId,
              reason: verification.failureReason,
              severity: 'warn',
            });
            client.close(1008, 'Challenge verification failed');
            return;
          }

          // Mark connection as verified
          markChallengeVerified(client);

          logSecurityEvent('ws_challenge_verified', {
            userId,
            severity: 'info',
          });

          // Send success response
          client.send(
            JSON.stringify({
              type: 'challenge_verified',
              timestamp: Date.now(),
            })
          );
        });

        return;
      }

      // SECURITY CHECK 6: Require challenge verification before tool execution
      if (isToolExecuteMessage(message) || isToolResultMessage(message)) {
        if (!isChallengeVerified(client)) {
          logSecurityEvent('ws_unauthorized_tool_execution_attempt', {
            userId,
            toolName: isToolExecuteMessage(message) ? message.toolName : undefined,
            severity: 'warn',
          });
          client.send(
            JSON.stringify({
              type: 'error',
              error: 'challenge_required',
              message: 'Complete challenge verification first',
            })
          );
          return;
        }
      }

      // Handle ping/pong for health checks
      if (isPingMessage(message)) {
        // SECURITY CHECK 7: Verify connection fingerprint on ping to detect session hijacking
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

      // SECURITY CHECK 8: Connection health check before tool execution
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
    clearChallenge(userId);
  });

  // Handle errors
  client.on('error', (error) => {
    logSecurityEvent('ws_error', {
      userId,
      error: error instanceof Error ? error.message : String(error),
      severity: 'error',
    });
  });

  // Note: Welcome message NOT sent until challenge is verified
  // Client must complete challenge-response before tool execution
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
