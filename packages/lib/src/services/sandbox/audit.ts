/**
 * Code execution audit (pure builders + a fire-and-forget writer).
 *
 * Every run produces an immutable audit record — actor, (redacted) code,
 * profile, exit, duration, cost, timestamp — written to the hash-chained
 * activity log. Anomalous runs (timeout, OOM, blocked command, non-zero exit)
 * additionally raise a security audit event for forensics.
 *
 * The builders are pure: they take an injected timestamp and never read the
 * clock, so they are trivially testable. The writer isolates IO behind injected
 * sinks and is fire-and-forget: a failing audit sink must never break or block
 * the run it is recording.
 */

import type { ActivityLogInput } from '../../monitoring/activity-logger';
import type { AuditEvent } from '../../audit/security-audit';
import type { ExecutionProfile } from './execution-policy';

export type CodeExecutionAnomaly =
  | 'timeout'
  | 'oom'
  | 'blocked_command'
  | 'nonzero_exit';

export interface CodeExecutionAuditInput {
  userId: string;
  actorEmail: string;
  actorDisplayName?: string;
  driveId: string | null;
  conversationId?: string;
  requestOrigin?: 'user' | 'agent';
  agentPageId?: string;
  profile: ExecutionProfile;
  code: string;
  exitCode: number | null;
  durationMs: number;
  costUsd?: number;
  timestamp: Date;
  anomaly?: CodeExecutionAnomaly;
  aiProvider?: string;
  aiModel?: string;
}

export interface CodeExecutionAuditRecord {
  userId: string;
  actorEmail: string;
  actorDisplayName?: string;
  driveId: string | null;
  conversationId?: string;
  requestOrigin: 'user' | 'agent';
  agentPageId?: string;
  profile: ExecutionProfile;
  /** Redacted and length-capped copy of the submitted code. */
  code: string;
  codeTruncated: boolean;
  exitCode: number | null;
  durationMs: number;
  costUsd: number;
  timestampIso: string;
  anomaly?: CodeExecutionAnomaly;
  aiProvider?: string;
  aiModel?: string;
}

const MAX_AUDITED_CODE_LENGTH = 4000;
const REDACTED = '***REDACTED***';

// Secret-bearing assignments: `API_KEY = "..."`, `token: '...'`, `password=...`.
const SECRET_ASSIGNMENT =
  /\b([A-Za-z0-9_-]*(?:key|secret|token|password|passwd|pwd|auth)[A-Za-z0-9_-]*)\b(\s*[:=]\s*)(['"]?)[^\s'"]+\3/gi;
// `Authorization: Bearer <token>`.
const BEARER_TOKEN = /\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{8,}/g;
// Standalone high-entropy tokens (provider key prefixes, long hex/base64).
const STANDALONE_TOKEN = /\b[A-Za-z0-9_-]*[A-Za-z0-9][A-Za-z0-9_-]{23,}\b/g;

function redactSecrets(code: string): string {
  return code
    .replace(SECRET_ASSIGNMENT, (_m, key, sep) => `${key}${sep}${REDACTED}`)
    .replace(BEARER_TOKEN, `Bearer ${REDACTED}`)
    .replace(STANDALONE_TOKEN, REDACTED);
}

export function buildAuditRecord({
  userId,
  actorEmail,
  actorDisplayName,
  driveId,
  conversationId,
  requestOrigin = 'user',
  agentPageId,
  profile,
  code,
  exitCode,
  durationMs,
  costUsd = 0,
  timestamp,
  anomaly,
  aiProvider,
  aiModel,
}: CodeExecutionAuditInput): CodeExecutionAuditRecord {
  // Truncate the raw code to the cap BEFORE redacting, so the redaction regexes
  // only ever run over a bounded input (no ReDoS surface on large submissions).
  // codeTruncated reflects the raw length the agent submitted.
  const codeTruncated = code.length > MAX_AUDITED_CODE_LENGTH;
  const bounded = codeTruncated ? code.slice(0, MAX_AUDITED_CODE_LENGTH) : code;

  return {
    userId,
    actorEmail,
    actorDisplayName,
    driveId,
    conversationId,
    requestOrigin,
    agentPageId,
    profile,
    code: redactSecrets(bounded),
    codeTruncated,
    exitCode,
    durationMs,
    costUsd,
    timestampIso: timestamp.toISOString(),
    anomaly,
    aiProvider,
    aiModel,
  };
}

export function buildActivityLogInput(record: CodeExecutionAuditRecord): ActivityLogInput {
  const scopedToConversation = Boolean(record.conversationId);
  return {
    userId: record.userId,
    operation: 'code_execution',
    resourceType: scopedToConversation ? 'conversation' : 'drive',
    resourceId: record.conversationId ?? record.driveId ?? record.userId,
    driveId: record.driveId,
    actorEmail: record.actorEmail,
    actorDisplayName: record.actorDisplayName,
    isAiGenerated: true,
    aiProvider: record.aiProvider,
    aiModel: record.aiModel,
    aiConversationId: record.conversationId,
    metadata: {
      profile: record.profile,
      exitCode: record.exitCode,
      durationMs: record.durationMs,
      costUsd: record.costUsd,
      requestOrigin: record.requestOrigin,
      agentPageId: record.agentPageId,
      code: record.code,
      codeTruncated: record.codeTruncated,
      anomaly: record.anomaly,
    },
  };
}

const ANOMALY_RISK: Record<CodeExecutionAnomaly, number> = {
  timeout: 0.4,
  oom: 0.4,
  nonzero_exit: 0.3,
  blocked_command: 0.8,
};

export function buildSecurityAuditEvent(
  record: CodeExecutionAuditRecord,
): AuditEvent | null {
  if (!record.anomaly) return null;
  return {
    eventType: 'security.suspicious.activity',
    userId: record.userId,
    resourceType: 'code_execution',
    resourceId: record.conversationId ?? record.driveId ?? record.userId,
    riskScore: ANOMALY_RISK[record.anomaly],
    anomalyFlags: [record.anomaly],
    details: {
      profile: record.profile,
      exitCode: record.exitCode,
      durationMs: record.durationMs,
      driveId: record.driveId,
      requestOrigin: record.requestOrigin,
      agentPageId: record.agentPageId,
    },
  };
}

export interface WriteAuditDeps {
  logActivity: (input: ActivityLogInput) => Promise<void>;
  logSecurityEvent: (event: AuditEvent) => Promise<void>;
}

// The real sinks pull in the database; import them lazily so unit tests that
// inject fakes never load the DB module graph.
const defaultDeps: WriteAuditDeps = {
  logActivity: (input) =>
    import('../../monitoring/activity-logger').then((m) => m.logActivity(input)),
  logSecurityEvent: (event) =>
    import('../../audit/security-audit').then((m) => m.securityAudit.logEvent(event)),
};

export async function writeCodeExecutionAudit({
  input,
  deps = defaultDeps,
}: {
  input: CodeExecutionAuditInput;
  deps?: WriteAuditDeps;
}): Promise<void> {
  const record = buildAuditRecord(input);
  const securityEvent = buildSecurityAuditEvent(record);

  await Promise.allSettled([
    deps.logActivity(buildActivityLogInput(record)),
    ...(securityEvent ? [deps.logSecurityEvent(securityEvent)] : []),
  ]);
}
