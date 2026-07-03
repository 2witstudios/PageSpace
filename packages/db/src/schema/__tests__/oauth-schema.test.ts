/**
 * OAuth 2.1 provider schema — Phase 1 task 1 (epic page ea07mt5jvw0flihsbjce1iv9,
 * ADR 0002 §Decision 3, ADR 0003 §3.1). Asserts table/column/constraint shapes
 * without a live DB: hash-only secret storage, FK cascade targets, and
 * nullability per the zero-trust ground rules on the phase page.
 *
 * A plaintext secret column anywhere in this schema is an automatic failure —
 * the generic sweep at the bottom enforces that across every table here.
 */
import { describe, it, expect } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { getTableColumns } from 'drizzle-orm';
import {
  oauthClients,
  oauthClientsRelations,
  oauthAuthorizationCodes,
  oauthAuthorizationCodesRelations,
  oauthDeviceCodes,
  oauthDeviceCodesRelations,
  oauthRefreshTokens,
  oauthRefreshTokensRelations,
  oauthAccessTokens,
  oauthAccessTokensRelations,
} from '../oauth';

function fkOnColumn(config: ReturnType<typeof getTableConfig>, columnName: string) {
  const fk = config.foreignKeys.find((candidate) =>
    candidate.reference().columns.some((column) => column.name === columnName)
  );
  expect(fk, `expected a foreign key on ${columnName}`).toBeDefined();
  return fk!;
}

describe('oauthClients', () => {
  const config = getTableConfig(oauthClients);
  const columns = getTableColumns(oauthClients);

  it('is table oauth_clients', () => {
    expect(config.name).toBe('oauth_clients');
  });

  it('requires a unique client_id', () => {
    expect(columns.clientId.notNull).toBe(true);
    expect(columns.clientId.isUnique).toBe(true);
  });

  it('requires name and clientType', () => {
    expect(columns.name.notNull).toBe(true);
    expect(columns.clientType.notNull).toBe(true);
  });

  it('constrains clientType to public|confidential', () => {
    const enumValues = (columns.clientType as unknown as { enumValues: string[] }).enumValues;
    expect(enumValues).toEqual(['public', 'confidential']);
  });

  it('requires redirectUris and defaults isFirstParty to false', () => {
    expect(columns.redirectUris.notNull).toBe(true);
    expect(columns.isFirstParty.notNull).toBe(true);
    expect(columns.isFirstParty.default).toBe(false);
  });

  it('createdAt is required, disabledAt (revocation) is nullable', () => {
    expect(columns.createdAt.notNull).toBe(true);
    expect(columns.disabledAt.notNull).toBe(false);
  });

  it('exports relations to codes and tokens', () => {
    expect(oauthClientsRelations).toBeDefined();
  });
});

describe('oauthAuthorizationCodes', () => {
  const config = getTableConfig(oauthAuthorizationCodes);
  const columns = getTableColumns(oauthAuthorizationCodes);

  it('is table oauth_authorization_codes', () => {
    expect(config.name).toBe('oauth_authorization_codes');
  });

  it('stores only a hash + prefix of the code, never the code itself', () => {
    expect(columns.codeHash.notNull).toBe(true);
    expect(columns.codeHash.isUnique).toBe(true);
    expect(columns.codePrefix.notNull).toBe(true);
    expect((columns as Record<string, unknown>).code).toBeUndefined();
  });

  it('cascade-deletes when the owning client is deleted', () => {
    expect(fkOnColumn(config, 'clientId').onDelete).toBe('cascade');
  });

  it('cascade-deletes when the owning user is deleted', () => {
    expect(fkOnColumn(config, 'userId').onDelete).toBe('cascade');
  });

  it('requires redirectUri, PKCE challenge fields, scopes, and expiresAt', () => {
    expect(columns.redirectUri.notNull).toBe(true);
    expect(columns.codeChallenge.notNull).toBe(true);
    expect(columns.codeChallengeMethod.notNull).toBe(true);
    expect(columns.scopes.notNull).toBe(true);
    expect(columns.expiresAt.notNull).toBe(true);
  });

  it('consumedAt is nullable (one-time-use, unconsumed by default)', () => {
    expect(columns.consumedAt.notNull).toBe(false);
  });

  it('exports relations to client and user', () => {
    expect(oauthAuthorizationCodesRelations).toBeDefined();
  });
});

describe('oauthDeviceCodes', () => {
  const config = getTableConfig(oauthDeviceCodes);
  const columns = getTableColumns(oauthDeviceCodes);

  it('is table oauth_device_codes', () => {
    expect(config.name).toBe('oauth_device_codes');
  });

  it('stores only hash + prefix of the device code and the user code, never the codes themselves', () => {
    expect(columns.deviceCodeHash.notNull).toBe(true);
    expect(columns.deviceCodeHash.isUnique).toBe(true);
    expect(columns.deviceCodePrefix.notNull).toBe(true);
    expect(columns.userCodeHash.notNull).toBe(true);
    expect(columns.userCodeHash.isUnique).toBe(true);
    expect(columns.userCodePrefix.notNull).toBe(true);
    expect((columns as Record<string, unknown>).deviceCode).toBeUndefined();
    expect((columns as Record<string, unknown>).userCode).toBeUndefined();
  });

  it('cascade-deletes when the owning client is deleted', () => {
    expect(fkOnColumn(config, 'clientId').onDelete).toBe('cascade');
  });

  it('cascade-deletes when the approving user is deleted, but userId starts nullable (unapproved)', () => {
    expect(fkOnColumn(config, 'userId').onDelete).toBe('cascade');
    expect(columns.userId.notNull).toBe(false);
  });

  it('requires scopes and expiresAt; approvedAt/deniedAt/lastPolledAt are nullable', () => {
    expect(columns.scopes.notNull).toBe(true);
    expect(columns.expiresAt.notNull).toBe(true);
    expect(columns.approvedAt.notNull).toBe(false);
    expect(columns.deniedAt.notNull).toBe(false);
    expect(columns.lastPolledAt.notNull).toBe(false);
  });

  it('requires pollIntervalSeconds with a sane default', () => {
    expect(columns.pollIntervalSeconds.notNull).toBe(true);
    expect(columns.pollIntervalSeconds.default).toBeGreaterThan(0);
  });

  it('exports relations to client and user', () => {
    expect(oauthDeviceCodesRelations).toBeDefined();
  });
});

describe('oauthRefreshTokens', () => {
  const config = getTableConfig(oauthRefreshTokens);
  const columns = getTableColumns(oauthRefreshTokens);

  it('is table oauth_refresh_tokens', () => {
    expect(config.name).toBe('oauth_refresh_tokens');
  });

  it('stores only a hash + prefix of the token, never the token itself', () => {
    expect(columns.tokenHash.notNull).toBe(true);
    expect(columns.tokenHash.isUnique).toBe(true);
    expect(columns.tokenPrefix.notNull).toBe(true);
    expect((columns as Record<string, unknown>).token).toBeUndefined();
  });

  it('carries the ADR 0003 §3.1 required rotation-family columns', () => {
    expect(columns.familyId.notNull).toBe(true);
    expect(columns.familyExpiresAt.notNull).toBe(true);
    expect(columns.replacedByTokenId.notNull).toBe(false);
    expect(columns.revokedAt.notNull).toBe(false);
    expect(columns.revokedReason.notNull).toBe(false);
  });

  it('carries clientId, userId, scopes, tokenVersion, expiresAt per ADR 0003 §3.1', () => {
    expect(columns.scopes.notNull).toBe(true);
    expect(columns.tokenVersion.notNull).toBe(true);
    expect(columns.expiresAt.notNull).toBe(true);
  });

  it('cascade-deletes when the owning client is deleted', () => {
    expect(fkOnColumn(config, 'clientId').onDelete).toBe('cascade');
  });

  it('cascade-deletes when the owning user is deleted', () => {
    expect(fkOnColumn(config, 'userId').onDelete).toBe('cascade');
  });

  it('exports relations to client and user', () => {
    expect(oauthRefreshTokensRelations).toBeDefined();
  });
});

describe('oauthAccessTokens', () => {
  const config = getTableConfig(oauthAccessTokens);
  const columns = getTableColumns(oauthAccessTokens);

  it('is table oauth_access_tokens', () => {
    expect(config.name).toBe('oauth_access_tokens');
  });

  it('stores only a hash + prefix of the token, never the token itself', () => {
    expect(columns.tokenHash.notNull).toBe(true);
    expect(columns.tokenHash.isUnique).toBe(true);
    expect(columns.tokenPrefix.notNull).toBe(true);
    expect((columns as Record<string, unknown>).token).toBeUndefined();
  });

  it('carries familyId so a family revocation can reach every access token it issued', () => {
    expect(columns.familyId.notNull).toBe(true);
  });

  it('carries clientId, userId, scopes, tokenVersion, expiresAt, and revocation fields', () => {
    expect(columns.scopes.notNull).toBe(true);
    expect(columns.tokenVersion.notNull).toBe(true);
    expect(columns.expiresAt.notNull).toBe(true);
    expect(columns.revokedAt.notNull).toBe(false);
    expect(columns.revokedReason.notNull).toBe(false);
  });

  it('cascade-deletes when the owning client is deleted', () => {
    expect(fkOnColumn(config, 'clientId').onDelete).toBe('cascade');
  });

  it('cascade-deletes when the owning user is deleted', () => {
    expect(fkOnColumn(config, 'userId').onDelete).toBe('cascade');
  });

  it('exports relations to client and user', () => {
    expect(oauthAccessTokensRelations).toBeDefined();
  });
});

describe('zero trust — no plaintext secret column anywhere in this schema', () => {
  const forbidden = /^(code|token|device_?code|user_?code|secret|verifier|password)$/i;
  const tables = {
    oauth_clients: oauthClients,
    oauth_authorization_codes: oauthAuthorizationCodes,
    oauth_device_codes: oauthDeviceCodes,
    oauth_refresh_tokens: oauthRefreshTokens,
    oauth_access_tokens: oauthAccessTokens,
  };

  for (const [tableName, table] of Object.entries(tables)) {
    it(`${tableName} has no bare secret column`, () => {
      const columns = getTableColumns(table);
      const offending = Object.values(columns)
        .map((column) => column.name)
        .filter((name) => forbidden.test(name));
      expect(offending).toEqual([]);
    });
  }
});
