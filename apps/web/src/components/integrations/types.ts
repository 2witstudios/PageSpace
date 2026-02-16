/**
 * Frontend-specific integration types.
 * Mirrors backend types but with only the fields returned by APIs.
 */

export type ConnectionStatus = 'active' | 'expired' | 'error' | 'pending' | 'revoked';

export interface SafeProvider {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  iconUrl: string | null;
  documentationUrl: string | null;
  providerType: string;
  isSystem: boolean;
  enabled: boolean;
  createdAt: string;
}

export interface SafeConnection {
  id: string;
  providerId: string;
  name: string;
  status: ConnectionStatus;
  statusMessage: string | null;
  visibility?: 'private' | 'owned_drives' | 'all_drives';
  accountMetadata: {
    accountId?: string;
    accountName?: string;
    email?: string;
    avatarUrl?: string;
    workspaceName?: string;
  } | null;
  baseUrlOverride: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  provider: {
    id: string;
    slug: string;
    name: string;
    description: string | null;
  } | null;
}

export interface SafeGrant {
  id: string;
  agentId: string;
  connectionId: string;
  allowedTools: string[] | null;
  deniedTools: string[] | null;
  readOnly: boolean;
  rateLimitOverride: { requestsPerMinute?: number } | null;
  createdAt: string;
  connection: {
    id: string;
    name: string;
    status: ConnectionStatus;
    provider: {
      slug: string;
      name: string;
    } | null;
  } | null;
}

export interface AuditLogEntry {
  id: string;
  driveId: string | null;
  agentId: string;
  userId: string;
  connectionId: string;
  toolName: string;
  inputSummary: string | null;
  success: boolean;
  responseCode: number | null;
  errorType: string | null;
  errorMessage: string | null;
  durationMs: number | null;
  createdAt: string;
}
