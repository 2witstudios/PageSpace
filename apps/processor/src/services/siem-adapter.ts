import { createHash, createHmac } from 'crypto';
import * as net from 'net';
import * as dgram from 'dgram';
import { validateExternalURL } from '@pagespace/lib/security';

// Sources the SIEM worker can read from. Each source has its own cursor row
// in siem_delivery_cursors and its own pure-function row mapper.
export type AuditLogSource = 'activity_logs' | 'security_audit_log';

// Types for audit log entries
export interface AuditLogEntry {
  id: string;
  source: AuditLogSource;
  timestamp: Date;
  userId: string | null;
  actorEmail: string;
  actorDisplayName: string | null;
  isAiGenerated: boolean;
  aiProvider: string | null;
  aiModel: string | null;
  aiConversationId: string | null;
  operation: string;
  resourceType: string;
  resourceId: string;
  resourceTitle: string | null;
  driveId: string | null;
  pageId: string | null;
  metadata: Record<string, unknown> | null;
  previousLogHash: string | null;
  logHash: string | null;
}

// SIEM delivery result
export interface SiemDeliveryResult {
  success: boolean;
  entriesDelivered: number;
  error?: string;
  retryable?: boolean;
  // Delivery attestation — stamped by the delivery path so the worker can
  // persist receipts without re-doing any of the work.
  //
  // For webhook: `deliveryId` echoes the caller-supplied id; `webhookStatus`
  // is the last HTTP status observed; `responseHash` is a SHA-256 of the
  // response body (truncated to 64 hex chars); `ackReceivedAt` is non-null
  // only when the receiver echoed X-PageSpace-Delivery-Ack with a matching id.
  //
  // For syslog: `deliveryId` still echoes, but `webhookStatus`, `responseHash`,
  // and `ackReceivedAt` are all `null` — syslog is connectionless and has no
  // ack mechanism. The deliveryId is stamped into the pagespace@52000 SD-PARAM
  // for the receiver's forensic use.
  deliveryId?: string;
  webhookStatus?: number | null;
  ackReceivedAt?: Date | null;
  responseHash?: string | null;
}

// Configuration types
export type SiemType = 'webhook' | 'syslog';
export type SyslogProtocol = 'tcp' | 'udp';
export type SyslogFacility = 'local0' | 'local1' | 'local2' | 'local3' | 'local4' | 'local5' | 'local6' | 'local7';

export interface SiemConfig {
  enabled: boolean;
  type: SiemType;
  webhook?: WebhookConfig;
  syslog?: SyslogConfig;
}

export interface WebhookConfig {
  url: string;
  secret: string;
  batchSize: number;
  retryAttempts: number;
}

export interface SyslogConfig {
  host: string;
  port: number;
  protocol: SyslogProtocol;
  facility: SyslogFacility;
}

// Syslog facility codes (RFC 5424)
const SYSLOG_FACILITY_CODES: Record<SyslogFacility, number> = {
  local0: 16,
  local1: 17,
  local2: 18,
  local3: 19,
  local4: 20,
  local5: 21,
  local6: 22,
  local7: 23,
};

// Syslog severity levels (RFC 5424)
const SYSLOG_SEVERITY = {
  EMERGENCY: 0,
  ALERT: 1,
  CRITICAL: 2,
  ERROR: 3,
  WARNING: 4,
  NOTICE: 5,
  INFORMATIONAL: 6,
  DEBUG: 7,
};

// Maximum syslog message size (8KB for UDP safety)
const MAX_SYSLOG_MESSAGE_SIZE = 8192;

/**
 * Load SIEM configuration from environment variables
 */
export function loadSiemConfig(): SiemConfig {
  const enabled = process.env.AUDIT_SIEM_ENABLED === 'true';
  const type = (process.env.AUDIT_SIEM_TYPE || 'webhook') as SiemType;

  const config: SiemConfig = {
    enabled,
    type,
  };

  if (type === 'webhook') {
    config.webhook = {
      url: process.env.AUDIT_WEBHOOK_URL || '',
      secret: process.env.AUDIT_WEBHOOK_SECRET || '',
      batchSize: parseInt(process.env.AUDIT_WEBHOOK_BATCH_SIZE || '100', 10),
      retryAttempts: parseInt(process.env.AUDIT_WEBHOOK_RETRY_ATTEMPTS || '3', 10),
    };
  } else if (type === 'syslog') {
    config.syslog = {
      host: process.env.SYSLOG_HOST || '',
      port: parseInt(process.env.SYSLOG_PORT || '514', 10),
      protocol: (process.env.SYSLOG_PROTOCOL || 'tcp') as SyslogProtocol,
      facility: (process.env.SYSLOG_FACILITY || 'local0') as SyslogFacility,
    };
  }

  return config;
}

/**
 * Validate SIEM configuration
 */
export function validateSiemConfig(config: SiemConfig): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!config.enabled) {
    return { valid: true, errors: [] };
  }

  if (config.type === 'webhook') {
    if (!config.webhook?.url) {
      errors.push('AUDIT_WEBHOOK_URL is required when SIEM type is webhook');
    }
    if (!config.webhook?.secret) {
      errors.push('AUDIT_WEBHOOK_SECRET is required for webhook HMAC authentication');
    }
    if (config.webhook?.batchSize && (config.webhook.batchSize < 1 || config.webhook.batchSize > 1000)) {
      errors.push('AUDIT_WEBHOOK_BATCH_SIZE must be between 1 and 1000');
    }
  } else if (config.type === 'syslog') {
    if (!config.syslog?.host) {
      errors.push('SYSLOG_HOST is required when SIEM type is syslog');
    }
    if (config.syslog?.port && (config.syslog.port < 1 || config.syslog.port > 65535)) {
      errors.push('SYSLOG_PORT must be between 1 and 65535');
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Compute HMAC-SHA256 signature for webhook payload
 */
export function computeHmacSignature(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Format audit log entry for webhook delivery
 *
 * `deliveryId` is threaded from the worker so the receiver sees the same id in
 * both the body and the `X-PageSpace-Delivery-Id` header, and can echo it back
 * via `X-PageSpace-Delivery-Ack` for end-to-end attestation.
 */
export function formatWebhookPayload(entries: AuditLogEntry[], deliveryId?: string): string {
  const payload = {
    version: '1.2',
    source: 'pagespace-audit',
    timestamp: new Date().toISOString(),
    ...(deliveryId ? { deliveryId } : {}),
    count: entries.length,
    entries: entries.map(entry => ({
      id: entry.id,
      source: entry.source,
      timestamp: entry.timestamp.toISOString(),
      actor: {
        userId: entry.userId,
        email: entry.actorEmail,
        displayName: entry.actorDisplayName,
      },
      ai: entry.isAiGenerated ? {
        provider: entry.aiProvider,
        model: entry.aiModel,
        conversationId: entry.aiConversationId,
      } : null,
      action: {
        operation: entry.operation,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId,
        resourceTitle: entry.resourceTitle,
      },
      context: {
        driveId: entry.driveId,
        pageId: entry.pageId,
      },
      metadata: entry.metadata,
      integrity: {
        logHash: entry.logHash,
        previousLogHash: entry.previousLogHash,
      },
    })),
  };

  return JSON.stringify(payload);
}

/**
 * Compute SHA-256 hash of a response body as a tamper-resistant delivery
 * attestation. Full 64-hex-char SHA-256 digest; stored on the receipt so an
 * operator can prove what body the receiver returned at ship time.
 */
export function hashResponseBody(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

/**
 * Send webhook request with HMAC authentication
 *
 * Receipt-related fields on the returned result:
 *  - `deliveryId`: echoes the caller-supplied id for round-trip confirmation
 *  - `webhookStatus`: last HTTP status observed (also on failure)
 *  - `responseHash`: SHA-256 of the response body, regardless of status
 *  - `ackReceivedAt`: non-null only when the response's
 *    X-PageSpace-Delivery-Ack header matched the outgoing deliveryId
 */
export async function sendWebhook(
  config: WebhookConfig,
  entries: AuditLogEntry[],
  deliveryId?: string
): Promise<SiemDeliveryResult> {
  const payload = formatWebhookPayload(entries, deliveryId);
  const signature = computeHmacSignature(payload, config.secret);

  try {
    // SSRF Protection: Validate webhook URL before fetching
    const validation = await validateExternalURL(config.url);

    if (!validation.valid) {
      console.error('SIEM webhook URL validation failed', {
        url: config.url,
        reason: validation.error,
      });
      return {
        success: false,
        entriesDelivered: 0,
        error: `Invalid webhook URL: ${validation.error || 'SSRF protection blocked request'}`,
        retryable: false, // Don't retry blocked URLs
        deliveryId,
        webhookStatus: null,
        ackReceivedAt: null,
        responseHash: null,
      };
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-PageSpace-Signature': signature,
      'X-PageSpace-Timestamp': new Date().toISOString(),
    };
    if (deliveryId) {
      headers['X-PageSpace-Delivery-Id'] = deliveryId;
    }

    // Proceed with fetch (only if validation passed)
    const response = await fetch(config.url, {
      method: 'POST',
      headers,
      body: payload,
    });

    let responseBody = '';
    try {
      if (typeof (response as { text?: unknown }).text === 'function') {
        responseBody = await response.text();
      }
    } catch {
      responseBody = '';
    }
    const responseHash = hashResponseBody(responseBody);

    // Ack round-trip: if the receiver echoed our id back, mark the delivery
    // as attested. Mismatch or missing → null (operator sees unattested).
    const headerAck = readResponseHeader(response, 'X-PageSpace-Delivery-Ack');
    const ackReceivedAt = deliveryId && headerAck && headerAck === deliveryId ? new Date() : null;

    if (response.ok) {
      return {
        success: true,
        entriesDelivered: entries.length,
        deliveryId,
        webhookStatus: response.status,
        ackReceivedAt,
        responseHash,
      };
    }

    // Determine if error is retryable
    const retryable = response.status >= 500 || response.status === 429;

    return {
      success: false,
      entriesDelivered: 0,
      error: `HTTP ${response.status}: ${responseBody || 'Unknown error'}`,
      retryable,
      deliveryId,
      webhookStatus: response.status,
      ackReceivedAt,
      responseHash,
    };
  } catch (error) {
    // Network errors are retryable
    return {
      success: false,
      entriesDelivered: 0,
      error: error instanceof Error ? error.message : 'Network error',
      retryable: true,
      deliveryId,
      webhookStatus: null,
      ackReceivedAt: null,
      responseHash: null,
    };
  }
}

/**
 * Minimal Response.headers accessor that survives the two header-bag shapes
 * node/undici may emit (Headers interface vs a plain object in test mocks).
 */
function readResponseHeader(response: Response, name: string): string | null {
  const headers = (response as unknown as { headers?: unknown }).headers;
  if (!headers) return null;
  if (typeof (headers as { get?: unknown }).get === 'function') {
    return (headers as { get: (name: string) => string | null }).get(name);
  }
  const plain = headers as Record<string, string | undefined>;
  return plain[name] ?? plain[name.toLowerCase()] ?? null;
}

/**
 * Format audit log entry as RFC 5424 syslog message
 */
export function formatSyslogMessage(
  entry: AuditLogEntry,
  facility: SyslogFacility,
  hostname?: string,
  deliveryId?: string
): string {
  const facilityCode = SYSLOG_FACILITY_CODES[facility];
  const severity = SYSLOG_SEVERITY.INFORMATIONAL;
  const priority = facilityCode * 8 + severity;

  // RFC 5424 format: <PRI>VERSION TIMESTAMP HOSTNAME APP-NAME PROCID MSGID STRUCTURED-DATA MSG
  const version = 1;
  const timestamp = entry.timestamp.toISOString();
  const host = hostname || process.env.HOSTNAME || 'pagespace';
  const appName = 'pagespace-audit';
  const procId = process.pid.toString();
  const msgId = entry.operation.toUpperCase();

  // Structured data (RFC 5424 section 6.3)
  const sdElements: string[] = [];

  // PageSpace audit data
  const auditData = [
    `id="${escapeSDParam(entry.id)}"`,
    `source="${escapeSDParam(entry.source)}"`,
    `userId="${escapeSDParam(entry.userId || '-')}"`,
    `email="${escapeSDParam(entry.actorEmail)}"`,
    `operation="${escapeSDParam(entry.operation)}"`,
    `resourceType="${escapeSDParam(entry.resourceType)}"`,
    `resourceId="${escapeSDParam(entry.resourceId)}"`,
  ];

  if (entry.resourceTitle) {
    auditData.push(`resourceTitle="${escapeSDParam(entry.resourceTitle)}"`);
  }
  if (entry.driveId) {
    auditData.push(`driveId="${escapeSDParam(entry.driveId)}"`);
  }
  if (entry.pageId) {
    auditData.push(`pageId="${escapeSDParam(entry.pageId)}"`);
  }
  if (entry.logHash) {
    auditData.push(`logHash="${escapeSDParam(entry.logHash)}"`);
  }
  if (deliveryId) {
    auditData.push(`deliveryId="${escapeSDParam(deliveryId)}"`);
  }

  sdElements.push(`[pagespace@52000 ${auditData.join(' ')}]`);

  // AI attribution if present
  if (entry.isAiGenerated) {
    const aiData = [
      `generated="true"`,
      `provider="${escapeSDParam(entry.aiProvider || '-')}"`,
      `model="${escapeSDParam(entry.aiModel || '-')}"`,
    ];
    if (entry.aiConversationId) {
      aiData.push(`conversationId="${escapeSDParam(entry.aiConversationId)}"`);
    }
    sdElements.push(`[pagespace-ai@52000 ${aiData.join(' ')}]`);
  }

  const structuredData = sdElements.length > 0 ? sdElements.join('') : '-';

  // Human-readable message
  const msg = `${entry.operation} ${entry.resourceType} ${entry.resourceId} by ${entry.actorEmail}`;

  // Construct full syslog message
  let syslogMessage = `<${priority}>${version} ${timestamp} ${host} ${appName} ${procId} ${msgId} ${structuredData} ${msg}`;

  // Truncate if exceeds max size (preserve structured data, truncate msg)
  if (Buffer.byteLength(syslogMessage, 'utf8') > MAX_SYSLOG_MESSAGE_SIZE) {
    const baseLength = Buffer.byteLength(
      `<${priority}>${version} ${timestamp} ${host} ${appName} ${procId} ${msgId} ${structuredData} `,
      'utf8'
    );
    const availableForMsg = MAX_SYSLOG_MESSAGE_SIZE - baseLength - 3; // -3 for "..."
    const truncatedMsg = truncateToByteLength(msg, availableForMsg) + '...';
    syslogMessage = `<${priority}>${version} ${timestamp} ${host} ${appName} ${procId} ${msgId} ${structuredData} ${truncatedMsg}`;
  }

  return syslogMessage;
}

/**
 * Escape special characters in SD-PARAM values (RFC 5424 section 6.3.3)
 */
function escapeSDParam(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/]/g, '\\]');
}

/**
 * Truncate string to specified byte length
 */
function truncateToByteLength(str: string, maxBytes: number): string {
  const buf = Buffer.from(str, 'utf8');
  /* c8 ignore next 3 */
  if (buf.length <= maxBytes) {
    return str;
  }
  return buf.slice(0, maxBytes).toString('utf8');
}

/**
 * Send syslog message via TCP
 */
export function sendSyslogTcp(
  config: SyslogConfig,
  entries: AuditLogEntry[],
  deliveryId?: string
): Promise<SiemDeliveryResult> {
  return new Promise((resolve) => {
    const client = new net.Socket();
    let entriesDelivered = 0;

    const timeout = setTimeout(() => {
      client.destroy();
      resolve({
        success: false,
        entriesDelivered,
        error: 'Connection timeout',
        retryable: true,
      });
    }, 10000);

    client.connect(config.port, config.host, () => {
      const sendNext = (index: number) => {
        if (index >= entries.length) {
          clearTimeout(timeout);
          client.end();
          resolve({
            success: true,
            entriesDelivered,
          });
          return;
        }

        const message = formatSyslogMessage(entries[index], config.facility, undefined, deliveryId);
        // RFC 5425: Octet-counting framing for TCP
        const framedMessage = `${Buffer.byteLength(message, 'utf8')} ${message}`;

        client.write(framedMessage, 'utf8', (err) => {
          if (err) {
            clearTimeout(timeout);
            client.destroy();
            resolve({
              success: false,
              entriesDelivered,
              error: err.message,
              retryable: true,
            });
            return;
          }
          entriesDelivered++;
          sendNext(index + 1);
        });
      };

      sendNext(0);
    });

    client.on('error', (err) => {
      clearTimeout(timeout);
      client.destroy();
      resolve({
        success: false,
        entriesDelivered,
        error: err.message,
        retryable: true,
      });
    });
  });
}

/**
 * Send syslog message via UDP
 */
export function sendSyslogUdp(
  config: SyslogConfig,
  entries: AuditLogEntry[],
  deliveryId?: string
): Promise<SiemDeliveryResult> {
  return new Promise((resolve) => {
    const client = dgram.createSocket('udp4');
    let entriesDelivered = 0;
    let hasError = false;

    const sendNext = (index: number) => {
      if (index >= entries.length || hasError) {
        client.close();
        resolve({
          success: !hasError,
          entriesDelivered,
          error: hasError ? 'UDP send error' : undefined,
          retryable: hasError,
        });
        return;
      }

      const message = formatSyslogMessage(entries[index], config.facility, undefined, deliveryId);
      const buffer = Buffer.from(message, 'utf8');

      client.send(buffer, 0, buffer.length, config.port, config.host, (err) => {
        if (err) {
          hasError = true;
          client.close();
          resolve({
            success: false,
            entriesDelivered,
            error: err.message,
            retryable: true,
          });
          return;
        }
        entriesDelivered++;
        sendNext(index + 1);
      });
    };

    client.on('error', (err) => {
      hasError = true;
      client.close();
      resolve({
        success: false,
        entriesDelivered,
        error: err.message,
        retryable: true,
      });
    });

    sendNext(0);
  });
}

/**
 * Send syslog messages using configured protocol
 */
export async function sendSyslog(
  config: SyslogConfig,
  entries: AuditLogEntry[],
  deliveryId?: string
): Promise<SiemDeliveryResult> {
  // SSRF Protection: Validate syslog host before connecting
  // Use validateExternalURL with a fake URL to leverage DNS resolution checks
  const fakeUrl = `syslog://${config.host}:${config.port}`;

  try {
    const validation = await validateExternalURL(fakeUrl);

    if (!validation.valid) {
      console.error('Syslog host validation failed', {
        host: config.host,
        port: config.port,
        reason: validation.error,
      });
      return {
        success: false,
        entriesDelivered: 0,
        error: `Invalid syslog host: ${validation.error || 'SSRF protection blocked connection'}`,
        retryable: false, // Don't retry blocked hosts
      };
    }
  } catch (validationError) {
    console.error('Syslog host validation error', {
      host: config.host,
      port: config.port,
      error: validationError instanceof Error ? validationError.message : String(validationError),
    });
    return {
      success: false,
      entriesDelivered: 0,
      error: `Host validation failed: ${validationError instanceof Error ? validationError.message : 'Unknown error'}`,
      retryable: false,
    };
  }

  // Proceed with socket connection (only if validation passed). Syslog is
  // connectionless — ack/status/responseHash are always null on success; the
  // deliveryId is still echoed so receipts are correctly indexed.
  const base = config.protocol === 'tcp'
    ? await sendSyslogTcp(config, entries, deliveryId)
    : await sendSyslogUdp(config, entries, deliveryId);

  return {
    ...base,
    deliveryId,
    webhookStatus: null,
    ackReceivedAt: null,
    responseHash: null,
  };
}

/**
 * Deliver audit log entries to SIEM
 */
export async function deliverToSiem(
  config: SiemConfig,
  entries: AuditLogEntry[],
  deliveryId?: string
): Promise<SiemDeliveryResult> {
  if (!config.enabled) {
    return {
      success: true,
      entriesDelivered: 0,
    };
  }

  if (entries.length === 0) {
    return {
      success: true,
      entriesDelivered: 0,
    };
  }

  if (config.type === 'webhook' && config.webhook) {
    return sendWebhook(config.webhook, entries, deliveryId);
  } else if (config.type === 'syslog' && config.syslog) {
    return sendSyslog(config.syslog, entries, deliveryId);
  }

  return {
    success: false,
    entriesDelivered: 0,
    error: 'Invalid SIEM configuration',
    retryable: false,
  };
}

/**
 * Deliver audit logs in batches (for webhook)
 */
export async function deliverToSiemBatched(
  config: SiemConfig,
  entries: AuditLogEntry[],
  deliveryId?: string
): Promise<SiemDeliveryResult> {
  if (!config.enabled || entries.length === 0) {
    return {
      success: true,
      entriesDelivered: 0,
    };
  }

  const batchSize = config.webhook?.batchSize || 100;
  let totalDelivered = 0;
  let lastError: string | undefined;
  let lastResult: SiemDeliveryResult | undefined;

  for (let i = 0; i < entries.length; i += batchSize) {
    const batch = entries.slice(i, i + batchSize);
    const result = await deliverToSiem(config, batch, deliveryId);
    lastResult = result;

    totalDelivered += result.entriesDelivered;

    if (!result.success) {
      lastError = result.error;
      // Stop on first failure for batched delivery
      return {
        success: false,
        entriesDelivered: totalDelivered,
        error: lastError,
        retryable: result.retryable,
        deliveryId,
        webhookStatus: result.webhookStatus ?? null,
        ackReceivedAt: result.ackReceivedAt ?? null,
        responseHash: result.responseHash ?? null,
      };
    }
  }

  return {
    success: true,
    entriesDelivered: totalDelivered,
    deliveryId,
    webhookStatus: lastResult?.webhookStatus ?? null,
    ackReceivedAt: lastResult?.ackReceivedAt ?? null,
    responseHash: lastResult?.responseHash ?? null,
  };
}

/**
 * Calculate exponential backoff delay
 */
export function calculateBackoffDelay(attempt: number, baseDelay: number = 1000): number {
  // Exponential backoff with jitter: baseDelay * 2^attempt + random jitter
  const exponentialDelay = baseDelay * Math.pow(2, attempt);
  const jitter = Math.random() * 1000;
  return Math.min(exponentialDelay + jitter, 60000); // Cap at 60 seconds
}

/**
 * Deliver with retry logic
 */
export async function deliverToSiemWithRetry(
  config: SiemConfig,
  entries: AuditLogEntry[],
  deliveryId?: string,
  maxRetries?: number
): Promise<SiemDeliveryResult> {
  const retries = maxRetries ?? config.webhook?.retryAttempts ?? 3;

  for (let attempt = 0; attempt <= retries; attempt++) {
    // Reuse the same deliveryId across retries so the receiver de-dupes and
    // the final receipt row attests a single logical "delivery", not N.
    const result = await deliverToSiemBatched(config, entries, deliveryId);

    if (result.success) {
      return result;
    }

    if (!result.retryable || attempt === retries) {
      return result;
    }

    // Wait before retry
    const delay = calculateBackoffDelay(attempt);
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  return {
    success: false,
    entriesDelivered: 0,
    error: 'Max retries exceeded',
    retryable: false,
    deliveryId,
    webhookStatus: null,
    ackReceivedAt: null,
    responseHash: null,
  };
}
