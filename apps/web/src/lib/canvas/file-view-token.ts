import { createHmac } from 'crypto';
import { secureCompare } from '@pagespace/lib/auth/secure-compare';

interface TokenPayload {
  driveId: string;
  pageId: string;
  exp: number;
}

interface CreateCanvasFileViewTokenParams {
  driveId: string;
  pageId: string;
  nowMs?: number;
  ttlMs?: number;
}

interface VerifyCanvasFileViewTokenParams {
  token: string | null | undefined;
  driveId: string;
  pageId: string;
  nowMs?: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

const getSecret = (): string => {
  const secret = process.env.CANVAS_FILE_VIEW_SECRET ?? process.env.CSRF_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('CANVAS_FILE_VIEW_SECRET or CSRF_SECRET must be configured and at least 32 characters');
  }
  return secret;
};

const encodeBase64Url = (value: string): string =>
  Buffer.from(value, 'utf8').toString('base64url');

const decodeBase64Url = (value: string): string =>
  Buffer.from(value, 'base64url').toString('utf8');

const sign = (payload: string): string =>
  createHmac('sha256', getSecret()).update(payload).digest('base64url');

export function createCanvasFileViewToken({
  driveId,
  pageId,
  nowMs = Date.now(),
  ttlMs = DEFAULT_TTL_MS,
}: CreateCanvasFileViewTokenParams): string {
  const payload = encodeBase64Url(JSON.stringify({
    driveId,
    pageId,
    exp: nowMs + ttlMs,
  } satisfies TokenPayload));

  return `${payload}.${sign(payload)}`;
}

export function verifyCanvasFileViewToken({
  token,
  driveId,
  pageId,
  nowMs = Date.now(),
}: VerifyCanvasFileViewTokenParams): boolean {
  if (!token || typeof token !== 'string') return false;

  const [payloadPart, signature, extra] = token.split('.');
  if (!payloadPart || !signature || extra !== undefined) return false;

  try {
    if (!secureCompare(signature, sign(payloadPart))) return false;

    const payload = JSON.parse(decodeBase64Url(payloadPart)) as Partial<TokenPayload>;
    return (
      payload.driveId === driveId &&
      payload.pageId === pageId &&
      typeof payload.exp === 'number' &&
      payload.exp >= nowMs
    );
  } catch {
    return false;
  }
}

