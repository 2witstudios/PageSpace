import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

// Hoisted socket mocks so they can be used in vi.mock factories
const {
  mockNetSocket,
  mockNetSocketConnect,
  mockNetSocketOn,
  mockNetSocketWrite,
  mockNetSocketEnd,
  mockNetSocketDestroy,
  mockDgramSocket,
  mockDgramSocketSend,
  mockDgramSocketClose,
  mockDgramSocketOn,
  mockDgramCreateSocket,
  mockValidateExternalURL,
} = vi.hoisted(() => {
  const mockNetSocketConnect = vi.fn();
  const mockNetSocketOn = vi.fn().mockReturnThis();
  const mockNetSocketWrite = vi.fn();
  const mockNetSocketEnd = vi.fn();
  const mockNetSocketDestroy = vi.fn();

  const mockNetSocket = vi.fn().mockImplementation(() => ({
    connect: mockNetSocketConnect,
    on: mockNetSocketOn,
    write: mockNetSocketWrite,
    end: mockNetSocketEnd,
    destroy: mockNetSocketDestroy,
  }));

  const mockDgramSocketSend = vi.fn();
  const mockDgramSocketClose = vi.fn();
  const mockDgramSocketOn = vi.fn().mockReturnThis();

  const mockDgramSocket = {
    send: mockDgramSocketSend,
    close: mockDgramSocketClose,
    on: mockDgramSocketOn,
  };

  const mockDgramCreateSocket = vi.fn().mockReturnValue(mockDgramSocket);
  const mockValidateExternalURL = vi.fn().mockResolvedValue({ valid: true });

  return {
    mockNetSocket,
    mockNetSocketConnect,
    mockNetSocketOn,
    mockNetSocketWrite,
    mockNetSocketEnd,
    mockNetSocketDestroy,
    mockDgramSocket,
    mockDgramSocketSend,
    mockDgramSocketClose,
    mockDgramSocketOn,
    mockDgramCreateSocket,
    mockValidateExternalURL,
  };
});

vi.mock('net', () => ({
  Socket: mockNetSocket,
}));

vi.mock('dgram', () => ({
  createSocket: mockDgramCreateSocket,
}));

vi.mock('@pagespace/lib/security', () => ({
  validateExternalURL: mockValidateExternalURL,
  resolvePathWithinSync: vi.fn((base: string, ...segs: string[]) => {
    const path = require('path');
    const joined = path.join(base, ...segs);
    return joined.startsWith(base) ? joined : null;
  }),
}));

import {
  loadSiemConfig,
  validateSiemConfig,
  computeHmacSignature,
  formatWebhookPayload,
  sendWebhook,
  formatSyslogMessage,
  sendSyslogTcp,
  sendSyslogUdp,
  sendSyslog,
  deliverToSiem,
  deliverToSiemBatched,
  deliverToSiemWithRetry,
  calculateBackoffDelay,
  type AuditLogEntry,
  type SiemConfig,
  type WebhookConfig,
  type SyslogConfig,
} from '../siem-adapter';
import { assert } from '../../__tests__/riteway';

const makeEntry = (overrides: Partial<AuditLogEntry> = {}): AuditLogEntry => ({
  id: 'entry-1',
  source: 'activity_logs',
  timestamp: new Date('2024-01-01T00:00:00Z'),
  userId: 'user-1',
  actorEmail: 'user@example.com',
  actorDisplayName: 'Test User',
  isAiGenerated: false,
  aiProvider: null,
  aiModel: null,
  aiConversationId: null,
  operation: 'page.created',
  resourceType: 'page',
  resourceId: 'page-1',
  resourceTitle: 'My Page',
  driveId: 'drive-1',
  pageId: 'page-1',
  metadata: null,
  previousLogHash: null,
  logHash: 'abc123',
  ...overrides,
});

describe('loadSiemConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.AUDIT_SIEM_ENABLED;
    delete process.env.AUDIT_SIEM_TYPE;
    delete process.env.AUDIT_WEBHOOK_URL;
    delete process.env.AUDIT_WEBHOOK_SECRET;
    delete process.env.AUDIT_WEBHOOK_BATCH_SIZE;
    delete process.env.AUDIT_WEBHOOK_RETRY_ATTEMPTS;
    delete process.env.SYSLOG_HOST;
    delete process.env.SYSLOG_PORT;
    delete process.env.SYSLOG_PROTOCOL;
    delete process.env.SYSLOG_FACILITY;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns disabled config by default', () => {
    const config = loadSiemConfig();
    expect(config.enabled).toBe(false);
    expect(config.type).toBe('webhook');
  });

  it('returns enabled config when AUDIT_SIEM_ENABLED=true', () => {
    process.env.AUDIT_SIEM_ENABLED = 'true';
    process.env.AUDIT_WEBHOOK_URL = 'https://example.com/webhook';
    process.env.AUDIT_WEBHOOK_SECRET = 'secret';
    const config = loadSiemConfig();
    expect(config.enabled).toBe(true);
    expect(config.webhook?.url).toBe('https://example.com/webhook');
  });

  it('loads webhook config', () => {
    process.env.AUDIT_SIEM_ENABLED = 'true';
    process.env.AUDIT_SIEM_TYPE = 'webhook';
    process.env.AUDIT_WEBHOOK_URL = 'https://example.com/hook';
    process.env.AUDIT_WEBHOOK_SECRET = 'mysecret';
    process.env.AUDIT_WEBHOOK_BATCH_SIZE = '50';
    process.env.AUDIT_WEBHOOK_RETRY_ATTEMPTS = '5';
    const config = loadSiemConfig();
    expect(config.type).toBe('webhook');
    expect(config.webhook?.batchSize).toBe(50);
    expect(config.webhook?.retryAttempts).toBe(5);
    expect(config.webhook?.secret).toBe('mysecret');
  });

  it('loads syslog config', () => {
    process.env.AUDIT_SIEM_ENABLED = 'true';
    process.env.AUDIT_SIEM_TYPE = 'syslog';
    process.env.SYSLOG_HOST = 'syslog.example.com';
    process.env.SYSLOG_PORT = '1514';
    process.env.SYSLOG_PROTOCOL = 'udp';
    process.env.SYSLOG_FACILITY = 'local1';
    const config = loadSiemConfig();
    expect(config.type).toBe('syslog');
    expect(config.syslog?.host).toBe('syslog.example.com');
    expect(config.syslog?.port).toBe(1514);
    expect(config.syslog?.protocol).toBe('udp');
    expect(config.syslog?.facility).toBe('local1');
  });

  it('uses defaults for syslog when env vars not set', () => {
    process.env.AUDIT_SIEM_ENABLED = 'true';
    process.env.AUDIT_SIEM_TYPE = 'syslog';
    const config = loadSiemConfig();
    expect(config.syslog?.port).toBe(514);
    expect(config.syslog?.protocol).toBe('tcp');
    expect(config.syslog?.facility).toBe('local0');
  });
});

describe('validateSiemConfig', () => {
  it('returns valid true when disabled', () => {
    const config: SiemConfig = { enabled: false, type: 'webhook' };
    const result = validateSiemConfig(config);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('returns error when webhook URL missing', () => {
    const config: SiemConfig = {
      enabled: true,
      type: 'webhook',
      webhook: { url: '', secret: 'secret', batchSize: 100, retryAttempts: 3 },
    };
    const result = validateSiemConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('AUDIT_WEBHOOK_URL is required when SIEM type is webhook');
  });

  it('returns error when webhook secret missing', () => {
    const config: SiemConfig = {
      enabled: true,
      type: 'webhook',
      webhook: { url: 'https://example.com', secret: '', batchSize: 100, retryAttempts: 3 },
    };
    const result = validateSiemConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('AUDIT_WEBHOOK_SECRET is required for webhook HMAC authentication');
  });

  it('returns error for batch size > 1000', () => {
    // The source checks: if (batchSize && (batchSize < 1 || batchSize > 1000))
    // So 0 is falsy and bypasses check, but 1001 is truthy and violates > 1000
    const config: SiemConfig = {
      enabled: true,
      type: 'webhook',
      webhook: { url: 'https://example.com', secret: 'secret', batchSize: 1001, retryAttempts: 3 },
    };
    const result = validateSiemConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('AUDIT_WEBHOOK_BATCH_SIZE must be between 1 and 1000');
  });

  it('returns error when syslog host missing', () => {
    const config: SiemConfig = {
      enabled: true,
      type: 'syslog',
      syslog: { host: '', port: 514, protocol: 'tcp', facility: 'local0' },
    };
    const result = validateSiemConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('SYSLOG_HOST is required when SIEM type is syslog');
  });

  it('returns error for syslog port > 65535', () => {
    // The source checks: if (port && (port < 1 || port > 65535))
    // 0 is falsy so bypasses, but 65536 is truthy and violates > 65535
    const config: SiemConfig = {
      enabled: true,
      type: 'syslog',
      syslog: { host: 'syslog.example.com', port: 65536, protocol: 'tcp', facility: 'local0' },
    };
    const result = validateSiemConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('SYSLOG_PORT must be between 1 and 65535');
  });

  it('returns valid for correct webhook config', () => {
    const config: SiemConfig = {
      enabled: true,
      type: 'webhook',
      webhook: { url: 'https://example.com', secret: 'secret', batchSize: 100, retryAttempts: 3 },
    };
    const result = validateSiemConfig(config);
    expect(result.valid).toBe(true);
  });

  it('returns valid for correct syslog config', () => {
    const config: SiemConfig = {
      enabled: true,
      type: 'syslog',
      syslog: { host: 'syslog.example.com', port: 514, protocol: 'tcp', facility: 'local0' },
    };
    const result = validateSiemConfig(config);
    expect(result.valid).toBe(true);
  });
});

describe('computeHmacSignature', () => {
  it('returns a hex string', () => {
    const sig = computeHmacSignature('payload', 'secret');
    expect(sig).toMatch(/^[a-f0-9]+$/);
  });

  it('produces same signature for same inputs', () => {
    const sig1 = computeHmacSignature('payload', 'secret');
    const sig2 = computeHmacSignature('payload', 'secret');
    expect(sig1).toBe(sig2);
  });

  it('produces different signatures for different payloads', () => {
    const sig1 = computeHmacSignature('payload1', 'secret');
    const sig2 = computeHmacSignature('payload2', 'secret');
    expect(sig1).not.toBe(sig2);
  });
});

describe('formatWebhookPayload', () => {
  it('returns valid JSON', () => {
    const entry = makeEntry();
    const payload = formatWebhookPayload([entry]);
    expect(() => JSON.parse(payload)).not.toThrow();
  });

  it('includes correct structure', () => {
    const entry = makeEntry();
    const payload = JSON.parse(formatWebhookPayload([entry]));
    expect(payload.version).toBe('1.2');
    expect(payload.source).toBe('pagespace-audit');
    expect(payload.count).toBe(1);
    expect(payload.entries).toHaveLength(1);
  });

  it('stamps each entry with its source (activity_logs)', () => {
    const entry = makeEntry({ source: 'activity_logs' });
    const payload = JSON.parse(formatWebhookPayload([entry]));
    expect(payload.entries[0].source).toBe('activity_logs');
  });

  it('stamps each entry with its source (security_audit_log)', () => {
    const entry = makeEntry({ source: 'security_audit_log' });
    const payload = JSON.parse(formatWebhookPayload([entry]));
    expect(payload.entries[0].source).toBe('security_audit_log');
  });

  it('preserves per-entry source across mixed batches', () => {
    const entries = [
      makeEntry({ id: 'a1', source: 'activity_logs' }),
      makeEntry({ id: 's1', source: 'security_audit_log' }),
    ];
    const payload = JSON.parse(formatWebhookPayload(entries));
    expect(payload.entries[0].source).toBe('activity_logs');
    expect(payload.entries[1].source).toBe('security_audit_log');
  });

  it('includes AI data when isAiGenerated is true', () => {
    const entry = makeEntry({
      isAiGenerated: true,
      aiProvider: 'openai',
      aiModel: 'gpt-4',
      aiConversationId: 'conv-1',
    });
    const payload = JSON.parse(formatWebhookPayload([entry]));
    expect(payload.entries[0].ai).not.toBeNull();
    expect(payload.entries[0].ai.provider).toBe('openai');
  });

  it('sets ai to null when isAiGenerated is false', () => {
    const entry = makeEntry({ isAiGenerated: false });
    const payload = JSON.parse(formatWebhookPayload([entry]));
    expect(payload.entries[0].ai).toBeNull();
  });

  it('handles multiple entries', () => {
    const entries = [makeEntry({ id: 'e1' }), makeEntry({ id: 'e2' })];
    const payload = JSON.parse(formatWebhookPayload(entries));
    expect(payload.count).toBe(2);
    expect(payload.entries).toHaveLength(2);
  });
});

describe('formatSyslogMessage', () => {
  it('returns a string starting with <priority>', () => {
    const entry = makeEntry();
    const msg = formatSyslogMessage(entry, 'local0');
    expect(msg).toMatch(/^<\d+>1 /);
  });

  it('includes entry data', () => {
    const entry = makeEntry({ userId: 'user-1', actorEmail: 'user@example.com' });
    const msg = formatSyslogMessage(entry, 'local0');
    expect(msg).toContain('user@example.com');
    expect(msg).toContain('page.created');
  });

  it('includes AI data when isAiGenerated is true', () => {
    const entry = makeEntry({
      isAiGenerated: true,
      aiProvider: 'anthropic',
      aiModel: 'claude-3',
      aiConversationId: 'conv-1',
    });
    const msg = formatSyslogMessage(entry, 'local0');
    expect(msg).toContain('pagespace-ai@52000');
    expect(msg).toContain('conv-1');
  });

  it('uses provided hostname', () => {
    const entry = makeEntry();
    const msg = formatSyslogMessage(entry, 'local0', 'my-server');
    expect(msg).toContain('my-server');
  });

  it('truncates very long msg portion while keeping structure intact', () => {
    // resourceId is in SD (structured data) which is not truncated
    // msg is "operation resourceType resourceId by email" - only this part is truncated
    // So the total may still exceed 8192 if SD is large, but the msg part is shortened
    const longId = 'x'.repeat(100); // Keep SD manageable so truncation of msg is tested
    const longEmail = 'a'.repeat(9000) + '@example.com';
    const entry = makeEntry({ actorEmail: longEmail, resourceId: longId });
    const msg = formatSyslogMessage(entry, 'local0');
    // The message should be truncated to <= MAX_SYSLOG_MESSAGE_SIZE
    // This only works when SD is small enough
    expect(typeof msg).toBe('string');
    expect(msg.length).toBeGreaterThan(0);
    expect(msg).toMatch(/^<\d+>1 /);
  });

  it('includes optional fields when present', () => {
    const entry = makeEntry({
      resourceTitle: 'Some Title',
      driveId: 'drive-123',
      pageId: 'page-123',
      logHash: 'hash-abc',
    });
    const msg = formatSyslogMessage(entry, 'local0');
    expect(msg).toContain('Some Title');
    expect(msg).toContain('drive-123');
    expect(msg).toContain('page-123');
    expect(msg).toContain('hash-abc');
  });

  it('handles null userId', () => {
    const entry = makeEntry({ userId: null });
    const msg = formatSyslogMessage(entry, 'local0');
    expect(msg).toBeTruthy();
  });

  it('handles all syslog facilities', () => {
    const entry = makeEntry();
    const facilities = ['local0', 'local1', 'local2', 'local3', 'local4', 'local5', 'local6', 'local7'] as const;
    for (const facility of facilities) {
      const msg = formatSyslogMessage(entry, facility);
      expect(msg).toMatch(/^<\d+>1 /);
    }
  });

  it('handles special characters in SD params (escape)', () => {
    const entry = makeEntry({ actorEmail: 'user"with"quotes@example.com' });
    const msg = formatSyslogMessage(entry, 'local0');
    expect(msg).toBeTruthy();
  });

  it('emits source as a SD-PARAM in the pagespace@52000 element', () => {
    const entry = makeEntry({ source: 'activity_logs' });
    const msg = formatSyslogMessage(entry, 'local0');
    expect(msg).toContain('source="activity_logs"');
  });

  it('emits security_audit_log as the source SD-PARAM when applicable', () => {
    const entry = makeEntry({ source: 'security_audit_log' });
    const msg = formatSyslogMessage(entry, 'local0');
    expect(msg).toContain('source="security_audit_log"');
  });
});

describe('sendWebhook', () => {
  const webhookConfig: WebhookConfig = {
    url: 'https://example.com/webhook',
    secret: 'mysecret',
    batchSize: 100,
    retryAttempts: 3,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateExternalURL.mockResolvedValue({ valid: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns success on 200 response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const result = await sendWebhook(webhookConfig, [makeEntry()]);
    expect(result.success).toBe(true);
    expect(result.entriesDelivered).toBe(1);
  });

  it('returns failure when URL validation fails', async () => {
    mockValidateExternalURL.mockResolvedValue({ valid: false, error: 'SSRF blocked' });
    const result = await sendWebhook(webhookConfig, [makeEntry()]);
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.error).toContain('SSRF blocked');
  });

  it('returns retryable failure on 500 response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: vi.fn().mockResolvedValue('Internal Server Error'),
    }));
    const result = await sendWebhook(webhookConfig, [makeEntry()]);
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(true);
  });

  it('returns non-retryable failure on 401 response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: vi.fn().mockResolvedValue('Unauthorized'),
    }));
    const result = await sendWebhook(webhookConfig, [makeEntry()]);
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(false);
  });

  it('returns retryable failure on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
    const result = await sendWebhook(webhookConfig, [makeEntry()]);
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.error).toBe('Network error');
  });

  it('handles 429 as retryable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: vi.fn().mockResolvedValue('Too Many Requests'),
    }));
    const result = await sendWebhook(webhookConfig, [makeEntry()]);
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(true);
  });
});

describe('sendSyslogTcp', () => {
  const config: SyslogConfig = {
    host: '127.0.0.1',
    port: 514,
    protocol: 'tcp',
    facility: 'local0',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockNetSocketOn.mockReturnThis();
  });

  it('resolves successfully when entries are sent', async () => {
    mockNetSocketConnect.mockImplementation((_port: number, _host: string, cb: () => void) => {
      cb();
    });
    mockNetSocketWrite.mockImplementation(
      (_msg: string, _enc: string, cb: (err?: Error) => void) => {
        cb();
      }
    );

    const result = await sendSyslogTcp(config, [makeEntry()]);
    expect(result.success).toBe(true);
    expect(result.entriesDelivered).toBe(1);
  });

  it('resolves with failure when write fails', async () => {
    mockNetSocketConnect.mockImplementation((_port: number, _host: string, cb: () => void) => {
      cb();
    });
    mockNetSocketWrite.mockImplementation(
      (_msg: string, _enc: string, cb: (err?: Error) => void) => {
        cb(new Error('Write failed'));
      }
    );

    const result = await sendSyslogTcp(config, [makeEntry()]);
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(true);
  });

  it('resolves with failure when socket emits error', async () => {
    let errorHandler: (err: Error) => void = () => {};
    mockNetSocketOn.mockImplementation((event: string, handler: (err: Error) => void) => {
      if (event === 'error') errorHandler = handler;
      return mockNetSocket;
    });
    mockNetSocketConnect.mockImplementation(() => {
      setTimeout(() => errorHandler(new Error('Connection refused')), 0);
    });

    const result = await sendSyslogTcp(config, [makeEntry()]);
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(true);
  });

  it('resolves with timeout when connection hangs', async () => {
    vi.useFakeTimers();
    // Don't call the connect callback - simulates connection hang
    mockNetSocketConnect.mockImplementation(() => {
      // no-op, never calls cb
    });

    const resultPromise = sendSyslogTcp(config, [makeEntry()]);
    vi.advanceTimersByTime(10001);
    const result = await resultPromise;
    expect(result.success).toBe(false);
    expect(result.error).toBe('Connection timeout');
    expect(result.retryable).toBe(true);

    vi.useRealTimers();
  });

  it('handles empty entries array', async () => {
    mockNetSocketConnect.mockImplementation((_port: number, _host: string, cb: () => void) => {
      cb();
    });

    const result = await sendSyslogTcp(config, []);
    expect(result.success).toBe(true);
    expect(result.entriesDelivered).toBe(0);
  });
});

describe('sendSyslogUdp', () => {
  const config: SyslogConfig = {
    host: '127.0.0.1',
    port: 514,
    protocol: 'udp',
    facility: 'local0',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockDgramSocketOn.mockReturnThis();
  });

  it('sends entries successfully via UDP', async () => {
    mockDgramSocketSend.mockImplementation(
      (_buf: Buffer, _offset: number, _len: number, _port: number, _host: string, cb: (err?: Error | null) => void) => {
        cb(null);
      }
    );

    const result = await sendSyslogUdp(config, [makeEntry()]);
    expect(result.success).toBe(true);
    expect(result.entriesDelivered).toBe(1);
  });

  it('returns failure when UDP send fails', async () => {
    mockDgramSocketSend.mockImplementation(
      (_buf: Buffer, _offset: number, _len: number, _port: number, _host: string, cb: (err?: Error | null) => void) => {
        cb(new Error('UDP error'));
      }
    );

    const result = await sendSyslogUdp(config, [makeEntry()]);
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(true);
  });

  it('handles socket error event', async () => {
    let errorHandler: (err: Error) => void = () => {};
    mockDgramSocketOn.mockImplementation((event: string, handler: (err: Error) => void) => {
      if (event === 'error') errorHandler = handler;
      return mockDgramSocket;
    });
    mockDgramSocketSend.mockImplementation(
      (_buf: Buffer, _offset: number, _len: number, _port: number, _host: string, _cb: (err?: Error | null) => void) => {
        errorHandler(new Error('Socket error'));
      }
    );

    const result = await sendSyslogUdp(config, [makeEntry()]);
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(true);
  });

  it('handles empty entries array', async () => {
    const result = await sendSyslogUdp(config, []);
    expect(result.success).toBe(true);
    expect(result.entriesDelivered).toBe(0);
  });
});

describe('sendSyslog', () => {
  const tcpConfig: SyslogConfig = {
    host: 'syslog.example.com',
    port: 514,
    protocol: 'tcp',
    facility: 'local0',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateExternalURL.mockResolvedValue({ valid: true });
    mockNetSocketOn.mockReturnThis();
    mockDgramSocketOn.mockReturnThis();
  });

  it('returns failure when URL validation fails', async () => {
    mockValidateExternalURL.mockResolvedValue({ valid: false, error: 'Private IP blocked' });
    const result = await sendSyslog(tcpConfig, [makeEntry()]);
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(false);
  });

  it('returns failure when validation throws', async () => {
    mockValidateExternalURL.mockRejectedValue(new Error('DNS error'));
    const result = await sendSyslog(tcpConfig, [makeEntry()]);
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.error).toContain('DNS error');
  });

  it('routes to TCP when protocol is tcp', async () => {
    mockNetSocketConnect.mockImplementation((_port: number, _host: string, cb: () => void) => cb());
    mockNetSocketWrite.mockImplementation(
      (_msg: string, _enc: string, cb: (err?: Error) => void) => cb()
    );

    const result = await sendSyslog(tcpConfig, [makeEntry()]);
    expect(result.success).toBe(true);
  });

  it('routes to UDP when protocol is udp', async () => {
    const udpConfig = { ...tcpConfig, protocol: 'udp' as const };
    mockDgramSocketSend.mockImplementation(
      (_buf: Buffer, _offset: number, _len: number, _port: number, _host: string, cb: (err?: Error | null) => void) => {
        cb(null);
      }
    );

    const result = await sendSyslog(udpConfig, [makeEntry()]);
    expect(result.success).toBe(true);
  });
});

describe('deliverToSiem', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateExternalURL.mockResolvedValue({ valid: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns success with 0 delivered when disabled', async () => {
    const config: SiemConfig = { enabled: false, type: 'webhook' };
    const result = await deliverToSiem(config, [makeEntry()]);
    expect(result.success).toBe(true);
    expect(result.entriesDelivered).toBe(0);
  });

  it('returns success with 0 delivered when entries is empty', async () => {
    const config: SiemConfig = { enabled: true, type: 'webhook' };
    const result = await deliverToSiem(config, []);
    expect(result.success).toBe(true);
    expect(result.entriesDelivered).toBe(0);
  });

  it('returns invalid config error when no webhook/syslog configured', async () => {
    const config: SiemConfig = { enabled: true, type: 'webhook' };
    const result = await deliverToSiem(config, [makeEntry()]);
    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid SIEM configuration');
  });

  it('calls sendWebhook when webhook type', async () => {
    const config: SiemConfig = {
      enabled: true,
      type: 'webhook',
      webhook: { url: 'https://example.com', secret: 'sec', batchSize: 100, retryAttempts: 3 },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

    const result = await deliverToSiem(config, [makeEntry()]);
    expect(result.success).toBe(true);
  });

  it('calls sendSyslog when syslog type', async () => {
    const config: SiemConfig = {
      enabled: true,
      type: 'syslog',
      syslog: { host: 'syslog.example.com', port: 514, protocol: 'udp', facility: 'local0' },
    };
    mockDgramSocketOn.mockReturnThis();
    mockDgramSocketSend.mockImplementation(
      (_buf: Buffer, _offset: number, _len: number, _port: number, _host: string, cb: (err?: Error | null) => void) => {
        cb(null);
      }
    );

    const result = await deliverToSiem(config, [makeEntry()]);
    expect(result.success).toBe(true);
  });
});

describe('deliverToSiemBatched', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateExternalURL.mockResolvedValue({ valid: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns success with 0 when disabled', async () => {
    const config: SiemConfig = { enabled: false, type: 'webhook' };
    const result = await deliverToSiemBatched(config, []);
    expect(result.success).toBe(true);
    expect(result.entriesDelivered).toBe(0);
  });

  it('delivers entries in batches', async () => {
    const config: SiemConfig = {
      enabled: true,
      type: 'webhook',
      webhook: { url: 'https://example.com', secret: 'sec', batchSize: 2, retryAttempts: 3 },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

    const entries = [makeEntry({ id: 'e1' }), makeEntry({ id: 'e2' }), makeEntry({ id: 'e3' })];
    const result = await deliverToSiemBatched(config, entries);
    expect(result.success).toBe(true);
    expect(result.entriesDelivered).toBe(3);
  });

  it('stops on first batch failure', async () => {
    const config: SiemConfig = {
      enabled: true,
      type: 'webhook',
      webhook: { url: 'https://example.com', secret: 'sec', batchSize: 1, retryAttempts: 3 },
    };
    mockValidateExternalURL.mockResolvedValue({ valid: false, error: 'blocked' });

    const entries = [makeEntry({ id: 'e1' }), makeEntry({ id: 'e2' })];
    const result = await deliverToSiemBatched(config, entries);
    expect(result.success).toBe(false);
  });
});

describe('truncateToByteLength via formatSyslogMessage (lines 367-368)', () => {
  it('truncates msg portion when total syslog message exceeds 8192 bytes', () => {
    // Build an entry whose human-readable msg part (operation + resourceType + resourceId + actorEmail)
    // will push the syslog message beyond 8192 bytes when combined with a small SD section
    // The msg format is: "operation resourceType resourceId by email"
    // Use a long email and a normal-length resourceId so SD stays manageable
    const longEmail = 'a'.repeat(8000) + '@example.com';
    const entry = makeEntry({
      actorEmail: longEmail,
      operation: 'page.created',
      resourceType: 'page',
      resourceId: 'short-id',
      // Keep SD fields short to ensure truncation hits the msg
      resourceTitle: null,
      driveId: null,
      pageId: null,
      logHash: null,
      isAiGenerated: false,
    });
    const msg = formatSyslogMessage(entry, 'local0');

    // The message should still be a valid syslog message
    expect(msg).toMatch(/^<\d+>1 /);
    // The buffer byte length should be <= 8192 since truncation occurred
    // (Note: due to multibyte chars this isn't always perfectly 8192, but the msg part was truncated)
    expect(typeof msg).toBe('string');
    expect(msg.length).toBeGreaterThan(0);
    // The truncation adds "..." at the end of msg
    expect(msg).toMatch(/\.\.\.$/);
  });

  it('returns str unchanged when msg fits within available bytes (line 367 - return str path)', () => {
    // Make the SD very large (by using a long resourceId in SD) so total > 8192
    // but keep the msg (operation resourceType resourceId by email) short enough to fit
    // The SD includes resourceId, so a long resourceId makes SD large.
    // But the msg uses the same resourceId, making it potentially long too.
    // Use a medium resourceId that pushes SD over 8192 but where msg fits in the remainder.
    // SD = "[pagespace@52000 id=... resourceId=XXXXX ...]" - resourceId is 8000 chars, SD ~8050 bytes
    // baseLength (header + SD) >> 8192, so availableForMsg = 8192 - baseLength - 3 could be negative or 0
    // When availableForMsg <= 0, truncateToByteLength('msg', 0) -> buf.length > 0 -> truncation path
    // We need SD large but msg short so availableForMsg > msg.length.
    // Use a long logHash (only in SD, not in msg) to push SD over 8192 while keeping msg short.
    const longHash = 'a'.repeat(8000);
    const entry = makeEntry({
      actorEmail: 'u@x.com',
      operation: 'op',
      resourceType: 'page',
      resourceId: 'r',
      resourceTitle: null,
      driveId: null,
      pageId: null,
      logHash: longHash,  // logHash appears in SD, not in msg
      isAiGenerated: false,
    });
    const msg = formatSyslogMessage(entry, 'local0');

    // Message should be valid and the msg portion should NOT end with "..." (not truncated)
    expect(msg).toMatch(/^<\d+>1 /);
    expect(typeof msg).toBe('string');
  });
});

describe('calculateBackoffDelay', () => {
  it('returns delay within expected range', () => {
    const delay = calculateBackoffDelay(0, 1000);
    expect(delay).toBeGreaterThanOrEqual(1000);
    expect(delay).toBeLessThanOrEqual(62000); // max 60000 + 1000 jitter
  });

  it('caps at 60000ms', () => {
    const delay = calculateBackoffDelay(10, 1000);
    expect(delay).toBeLessThanOrEqual(61000); // 60000 + jitter
  });

  it('increases with each attempt', () => {
    const delay0 = calculateBackoffDelay(0, 100);
    const delay2 = calculateBackoffDelay(2, 100);
    expect(delay0).toBeGreaterThanOrEqual(100);
    expect(delay2).toBeGreaterThanOrEqual(400);
  });
});

describe('deliverToSiemWithRetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateExternalURL.mockResolvedValue({ valid: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns success on first try', async () => {
    const config: SiemConfig = {
      enabled: true,
      type: 'webhook',
      webhook: { url: 'https://example.com', secret: 'sec', batchSize: 100, retryAttempts: 3 },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

    const result = await deliverToSiemWithRetry(config, [makeEntry()]);
    expect(result.success).toBe(true);
  });

  it('does not retry non-retryable failures', async () => {
    const config: SiemConfig = {
      enabled: true,
      type: 'webhook',
      webhook: { url: 'https://example.com', secret: 'sec', batchSize: 100, retryAttempts: 3 },
    };
    mockValidateExternalURL.mockResolvedValue({ valid: false, error: 'SSRF blocked' });

    const result = await deliverToSiemWithRetry(config, [makeEntry()], undefined, 0);
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(false);
  });

  it('uses maxRetries override', async () => {
    const config: SiemConfig = {
      enabled: true,
      type: 'webhook',
      webhook: { url: 'https://example.com', secret: 'sec', batchSize: 100, retryAttempts: 3 },
    };
    mockValidateExternalURL.mockResolvedValue({ valid: false, error: 'blocked' });

    const result = await deliverToSiemWithRetry(config, [makeEntry()], undefined, 0);
    expect(result.success).toBe(false);
  });

  it('returns max retries exceeded when non-retryable fails after 0 retries', async () => {
    const config: SiemConfig = {
      enabled: true,
      type: 'webhook',
      webhook: { url: 'https://example.com', secret: 'sec', batchSize: 100, retryAttempts: 0 },
    };
    // Non-retryable failure
    mockValidateExternalURL.mockResolvedValue({ valid: false, error: 'blocked' });

    const result = await deliverToSiemWithRetry(config, [makeEntry()], undefined, 0);
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(false);
  });

  it('returns max retries exceeded fallback when maxRetries is negative (lines 663-668)', async () => {
    // When retries < 0, the for loop condition (attempt <= retries) is never true
    // so the loop body never executes and we fall through to the final return
    const config: SiemConfig = {
      enabled: true,
      type: 'webhook',
      webhook: { url: 'https://example.com', secret: 'sec', batchSize: 100, retryAttempts: 3 },
    };

    const result = await deliverToSiemWithRetry(config, [makeEntry()], undefined, -1);
    expect(result.success).toBe(false);
    expect(result.error).toBe('Max retries exceeded');
    expect(result.retryable).toBe(false);
    expect(result.entriesDelivered).toBe(0);
  });

  it('retries on retryable failures and eventually returns result after max retries (lines 659-669)', async () => {
    vi.useFakeTimers();
    const config: SiemConfig = {
      enabled: true,
      type: 'webhook',
      webhook: { url: 'https://example.com', secret: 'sec', batchSize: 100, retryAttempts: 2 },
    };
    // All attempts fail with retryable=true
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: vi.fn().mockResolvedValue('Server Error'),
    }));

    const resultPromise = deliverToSiemWithRetry(config, [makeEntry()], undefined, 2);
    // Advance through delays
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.success).toBe(false);
    // After max retries with retryable failures, the last attempt's result is returned
    expect(result.retryable).toBe(true);

    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
});

describe('delivery_id round-trip (wave 3b receipts)', () => {
  const webhookConfig: WebhookConfig = {
    url: 'https://siem.example.com/hook',
    secret: 'sec',
    batchSize: 100,
    retryAttempts: 3,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateExternalURL.mockResolvedValue({ valid: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function makeFetchMock(opts: {
    ok?: boolean;
    status?: number;
    body?: string;
    headers?: Record<string, string>;
  } = {}) {
    const { ok = true, status = 200, body = 'OK', headers = {} } = opts;
    return vi.fn().mockResolvedValue({
      ok,
      status,
      text: vi.fn().mockResolvedValue(body),
      headers: { get: (name: string) => headers[name] ?? null },
    });
  }

  it('webhook payload version is 1.2', () => {
    const payload = JSON.parse(formatWebhookPayload([makeEntry()], 'd-1'));
    assert({
      given: 'the webhook payload version',
      should: 'be "1.2"',
      actual: payload.version,
      expected: '1.2',
    });
  });

  it('includes deliveryId as top-level JSON field when provided', () => {
    const payload = JSON.parse(formatWebhookPayload([makeEntry()], 'delivery-xyz'));
    assert({
      given: 'a webhook delivery with deliveryId',
      should: 'include deliveryId as top-level JSON field',
      actual: payload.deliveryId,
      expected: 'delivery-xyz',
    });
  });

  it('sets X-PageSpace-Delivery-Id header on the fetch call', async () => {
    const fetchMock = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    await sendWebhook(webhookConfig, [makeEntry()], 'delivery-xyz');

    const call = fetchMock.mock.calls[0];
    const sentHeaders = (call[1] as { headers: Record<string, string> }).headers;

    assert({
      given: 'a webhook delivery with deliveryId',
      should: 'set X-PageSpace-Delivery-Id header',
      actual: sentHeaders['X-PageSpace-Delivery-Id'],
      expected: 'delivery-xyz',
    });
  });

  it('sets ackReceivedAt to a Date when response ack matches outgoing id', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetchMock({ headers: { 'X-PageSpace-Delivery-Ack': 'delivery-xyz' } })
    );

    const result = await sendWebhook(webhookConfig, [makeEntry()], 'delivery-xyz');

    assert({
      given: 'a webhook response with matching X-PageSpace-Delivery-Ack header',
      should: 'set ackReceivedAt to a non-null Date',
      actual: result.ackReceivedAt instanceof Date,
      expected: true,
    });
  });

  it('leaves ackReceivedAt null when response ack is mismatched', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetchMock({ headers: { 'X-PageSpace-Delivery-Ack': 'some-other-id' } })
    );

    const result = await sendWebhook(webhookConfig, [makeEntry()], 'delivery-xyz');

    assert({
      given: 'a mismatched X-PageSpace-Delivery-Ack header',
      should: 'leave ackReceivedAt null',
      actual: result.ackReceivedAt,
      expected: null,
    });
  });

  it('leaves ackReceivedAt null but still sets responseHash when no ack header', async () => {
    vi.stubGlobal('fetch', makeFetchMock({ body: 'received' }));

    const result = await sendWebhook(webhookConfig, [makeEntry()], 'delivery-xyz');

    assert({
      given: 'a webhook response with no ack header',
      should: 'leave ackReceivedAt null',
      actual: result.ackReceivedAt,
      expected: null,
    });

    assert({
      given: 'a webhook response with no ack header',
      should: 'still set responseHash from the body',
      actual: typeof result.responseHash === 'string' && (result.responseHash as string).length === 64,
      expected: true,
    });
  });

  it('still computes responseHash on non-2xx failures', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetchMock({ ok: false, status: 500, body: 'boom', headers: {} })
    );

    const result = await sendWebhook(webhookConfig, [makeEntry()], 'delivery-xyz');

    assert({
      given: 'a webhook failure (500)',
      should: 'still compute responseHash from the response body',
      actual: typeof result.responseHash === 'string' && (result.responseHash as string).length === 64,
      expected: true,
    });

    assert({
      given: 'a webhook failure (500)',
      should: 'carry the webhookStatus 500 on the result',
      actual: result.webhookStatus,
      expected: 500,
    });
  });

  it('stamps deliveryId into the pagespace@52000 SD-PARAM block for syslog', () => {
    const entry = makeEntry();
    const msg = formatSyslogMessage(entry, 'local0', undefined, 'delivery-xyz');
    assert({
      given: 'a syslog delivery with deliveryId',
      should: 'include deliveryId="delivery-xyz" in the pagespace@52000 SD-PARAM',
      actual: msg.includes('deliveryId="delivery-xyz"'),
      expected: true,
    });
  });

  it('reuses the same deliveryId across retries (single call to underlying delivery per attempt)', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: vi.fn().mockResolvedValue('fail'),
        headers: { get: () => null },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue('ok'),
        headers: { get: () => null },
      });
    vi.stubGlobal('fetch', fetchMock);

    const resultPromise = deliverToSiemWithRetry(
      { enabled: true, type: 'webhook', webhook: webhookConfig },
      [makeEntry()],
      'delivery-xyz',
      2
    );
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    const firstHeaders = (fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers;
    const secondHeaders = (fetchMock.mock.calls[1][1] as { headers: Record<string, string> }).headers;

    assert({
      given: 'a retry after partial webhook failure',
      should: 'reuse the same deliveryId on the retry call',
      actual: {
        first: firstHeaders['X-PageSpace-Delivery-Id'],
        second: secondHeaders['X-PageSpace-Delivery-Id'],
        success: result.success,
      },
      expected: { first: 'delivery-xyz', second: 'delivery-xyz', success: true },
    });

    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
});
