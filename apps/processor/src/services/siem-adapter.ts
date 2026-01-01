import { createHmac } from 'crypto';
import * as net from 'net';
import * as dgram from 'dgram';

// Types for audit log entries
export interface AuditLogEntry {
  id: string;
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
 */
export function formatWebhookPayload(entries: AuditLogEntry[]): string {
  const payload = {
    version: '1.0',
    source: 'pagespace-audit',
    timestamp: new Date().toISOString(),
    count: entries.length,
    entries: entries.map(entry => ({
      id: entry.id,
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
 * Send webhook request with HMAC authentication
 */
export async function sendWebhook(
  config: WebhookConfig,
  entries: AuditLogEntry[]
): Promise<SiemDeliveryResult> {
  const payload = formatWebhookPayload(entries);
  const signature = computeHmacSignature(payload, config.secret);

  try {
    const response = await fetch(config.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-PageSpace-Signature': signature,
        'X-PageSpace-Timestamp': new Date().toISOString(),
      },
      body: payload,
    });

    if (response.ok) {
      return {
        success: true,
        entriesDelivered: entries.length,
      };
    }

    // Determine if error is retryable
    const retryable = response.status >= 500 || response.status === 429;
    const errorText = await response.text().catch(() => 'Unknown error');

    return {
      success: false,
      entriesDelivered: 0,
      error: `HTTP ${response.status}: ${errorText}`,
      retryable,
    };
  } catch (error) {
    // Network errors are retryable
    return {
      success: false,
      entriesDelivered: 0,
      error: error instanceof Error ? error.message : 'Network error',
      retryable: true,
    };
  }
}

/**
 * Format audit log entry as RFC 5424 syslog message
 */
export function formatSyslogMessage(
  entry: AuditLogEntry,
  facility: SyslogFacility,
  hostname?: string
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
  entries: AuditLogEntry[]
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

        const message = formatSyslogMessage(entries[index], config.facility);
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
  entries: AuditLogEntry[]
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

      const message = formatSyslogMessage(entries[index], config.facility);
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
  entries: AuditLogEntry[]
): Promise<SiemDeliveryResult> {
  if (config.protocol === 'tcp') {
    return sendSyslogTcp(config, entries);
  } else {
    return sendSyslogUdp(config, entries);
  }
}

/**
 * Deliver audit log entries to SIEM
 */
export async function deliverToSiem(
  config: SiemConfig,
  entries: AuditLogEntry[]
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
    return sendWebhook(config.webhook, entries);
  } else if (config.type === 'syslog' && config.syslog) {
    return sendSyslog(config.syslog, entries);
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
  entries: AuditLogEntry[]
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

  for (let i = 0; i < entries.length; i += batchSize) {
    const batch = entries.slice(i, i + batchSize);
    const result = await deliverToSiem(config, batch);

    totalDelivered += result.entriesDelivered;

    if (!result.success) {
      lastError = result.error;
      // Stop on first failure for batched delivery
      return {
        success: false,
        entriesDelivered: totalDelivered,
        error: lastError,
        retryable: result.retryable,
      };
    }
  }

  return {
    success: true,
    entriesDelivered: totalDelivered,
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
  maxRetries?: number
): Promise<SiemDeliveryResult> {
  const retries = maxRetries ?? config.webhook?.retryAttempts ?? 3;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const result = await deliverToSiemBatched(config, entries);

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
  };
}
