import { and, eq, gte, lte } from '@pagespace/db/operators'
import { integrationAuditLog } from '@pagespace/db/schema/integrations';
import { isValidId } from '@pagespace/lib/validators/id-validators';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_TOOL_NAME_LENGTH = 255;

type ParseResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export interface AuditFilterParams {
  connectionId: string | null;
  success: boolean | null;
  agentId: string | null;
  dateFrom: Date | null;
  dateTo: Date | null;
  toolName: string | null;
}

export interface AuditListParams extends AuditFilterParams {
  limit: number;
  offset: number;
}

function parseIntegerParam(
  rawValue: string | null,
  options: {
    name: string;
    min: number;
    defaultValue: number;
    max?: number;
  }
): ParseResult<number> {
  if (rawValue === null || rawValue.trim() === '') {
    return { ok: true, data: options.defaultValue };
  }

  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed)) {
    return { ok: false, error: `${options.name} must be an integer` };
  }
  if (parsed < options.min) {
    return { ok: false, error: `${options.name} must be >= ${options.min}` };
  }

  const bounded = options.max != null ? Math.min(parsed, options.max) : parsed;
  return { ok: true, data: bounded };
}

function parseDateParam(rawValue: string | null, fieldName: string): ParseResult<Date | null> {
  if (!rawValue) {
    return { ok: true, data: null };
  }

  const parsed = new Date(rawValue);
  if (Number.isNaN(parsed.getTime())) {
    return { ok: false, error: `Invalid ${fieldName} format` };
  }

  return { ok: true, data: parsed };
}

export function parseAuditFilterParams(searchParams: URLSearchParams): ParseResult<AuditFilterParams> {
  const connectionIdRaw = searchParams.get('connectionId');
  const connectionId = connectionIdRaw?.trim() || null;
  if (connectionId && !isValidId(connectionId)) {
    return { ok: false, error: 'Invalid connectionId format' };
  }

  const agentIdRaw = searchParams.get('agentId');
  const agentId = agentIdRaw?.trim() || null;
  if (agentId && !isValidId(agentId)) {
    return { ok: false, error: 'Invalid agentId format' };
  }

  const successRaw = searchParams.get('success');
  if (successRaw !== null && successRaw !== 'true' && successRaw !== 'false') {
    return { ok: false, error: 'Invalid success value (must be "true" or "false")' };
  }
  const success = successRaw === null ? null : successRaw === 'true';

  const dateFromResult = parseDateParam(searchParams.get('dateFrom'), 'dateFrom');
  if (!dateFromResult.ok) return dateFromResult;
  const dateToResult = parseDateParam(searchParams.get('dateTo'), 'dateTo');
  if (!dateToResult.ok) return dateToResult;

  if (dateFromResult.data && dateToResult.data && dateFromResult.data > dateToResult.data) {
    return { ok: false, error: 'dateFrom must be before or equal to dateTo' };
  }

  const toolNameRaw = searchParams.get('toolName');
  const toolName = toolNameRaw?.trim() || null;
  if (toolName && toolName.length > MAX_TOOL_NAME_LENGTH) {
    return { ok: false, error: `toolName exceeds max length of ${MAX_TOOL_NAME_LENGTH}` };
  }

  return {
    ok: true,
    data: {
      connectionId,
      success,
      agentId,
      dateFrom: dateFromResult.data,
      dateTo: dateToResult.data,
      toolName,
    },
  };
}

export function parseAuditListParams(searchParams: URLSearchParams): ParseResult<AuditListParams> {
  const filterResult = parseAuditFilterParams(searchParams);
  if (!filterResult.ok) return filterResult;

  const limitResult = parseIntegerParam(searchParams.get('limit'), {
    name: 'limit',
    min: 1,
    defaultValue: DEFAULT_LIMIT,
    max: MAX_LIMIT,
  });
  if (!limitResult.ok) return limitResult;

  const offsetResult = parseIntegerParam(searchParams.get('offset'), {
    name: 'offset',
    min: 0,
    defaultValue: 0,
  });
  if (!offsetResult.ok) return offsetResult;

  return {
    ok: true,
    data: {
      ...filterResult.data,
      limit: limitResult.data,
      offset: offsetResult.data,
    },
  };
}

export function buildAuditLogWhereClause(driveId: string, filters: AuditFilterParams) {
  const conditions = [eq(integrationAuditLog.driveId, driveId)];
  if (filters.connectionId) {
    conditions.push(eq(integrationAuditLog.connectionId, filters.connectionId));
  }
  if (filters.success !== null) {
    conditions.push(eq(integrationAuditLog.success, filters.success));
  }
  if (filters.agentId) {
    conditions.push(eq(integrationAuditLog.agentId, filters.agentId));
  }
  if (filters.dateFrom) {
    conditions.push(gte(integrationAuditLog.createdAt, filters.dateFrom));
  }
  if (filters.dateTo) {
    conditions.push(lte(integrationAuditLog.createdAt, filters.dateTo));
  }
  if (filters.toolName) {
    conditions.push(eq(integrationAuditLog.toolName, filters.toolName));
  }

  return conditions.length === 1 ? conditions[0] : and(...conditions);
}
