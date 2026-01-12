import { randomBytes } from 'crypto';
import { hashToken } from './token-utils';

export interface OpaqueToken {
  token: string;
  tokenHash: string;
  tokenPrefix: string;
}

export type TokenType = 'sess' | 'svc' | 'mcp' | 'dev';

/**
 * Generate cryptographically secure opaque token
 * Format: ps_{type}_{random}
 * 32 bytes = 256 bits of entropy
 */
export function generateOpaqueToken(type: TokenType): OpaqueToken {
  const randomPart = randomBytes(32).toString('base64url');
  const token = `ps_${type}_${randomPart}`;

  return {
    token,
    tokenHash: hashToken(token),
    tokenPrefix: token.substring(0, 12),
  };
}

export function isValidTokenFormat(token: string): boolean {
  if (typeof token !== 'string') return false;
  if (token.length < 40 || token.length > 100) return false;
  if (!token.startsWith('ps_')) return false;
  return /^ps_(sess|svc|mcp|dev)_[A-Za-z0-9_-]+$/.test(token);
}

export function getTokenType(token: string): TokenType | null {
  const match = token.match(/^ps_(sess|svc|mcp|dev)_/);
  return match ? (match[1] as TokenType) : null;
}
