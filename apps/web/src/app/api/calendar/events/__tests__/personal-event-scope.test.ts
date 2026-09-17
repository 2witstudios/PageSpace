/**
 * The personal-event rule as a table, and the list of calendar routes bound to
 * it (point-guard ruling: for an OAuth application, a personal/driveless event
 * is out of scope in EVERY calendar route; mcp_ keys keep #1846).
 */
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';
import { isPersonalEventOutOfScope, personalEventRefusal } from '../personal-event-scope';
import { PARITY_USER_ID, mcpDriveKey, oauthDriveGrant, profileOnlyGrant } from '@/lib/auth/__tests__/oauth-principal-fixture';
import type { AuthResult } from '@/lib/auth';

const session: AuthResult = { tokenType: 'session', sessionId: 's', userId: PARITY_USER_ID, role: 'user', tokenVersion: 0, adminRoleVersion: 0 };
const accountGrant: AuthResult = { ...oauthDriveGrant('drivex'), scopes: { ...oauthDriveGrant('drivex').scopes, account: true, drives: new Map() }, driveScopes: [], allowedDriveIds: [] };

const own = { driveId: null, createdById: PARITY_USER_ID };
const others = { driveId: null, createdById: 'someone-else' };
const inDrive = { driveId: 'drivex', createdById: 'someone-else' };

describe('personal-event-scope', () => {
  it.each([
    ['OAuth drive grant', oauthDriveGrant('drivex'), { own: true, others: true, inDrive: false }],
    ['OAuth profile-only token', profileOnlyGrant(), { own: true, others: true, inDrive: false }],
    ['OAuth account grant (acts as the user)', accountGrant, { own: false, others: false, inDrive: false }],
    ['drive-scoped mcp_ key', mcpDriveKey('drivex'), { own: false, others: true, inDrive: false }],
    ['session', session, { own: false, others: false, inDrive: false }],
  ] as const)('%s', (_label, principal, refused) => {
    expect(personalEventRefusal(principal, own) !== null).toBe(refused.own);
    expect(personalEventRefusal(principal, others) !== null).toBe(refused.others);
    expect(personalEventRefusal(principal, inDrive) !== null).toBe(refused.inDrive);
    expect(isPersonalEventOutOfScope(principal, own)).toBe(principal.tokenType === 'oauth' && principal !== accountGrant);
  });

  it('is applied by every calendar event route that admits oauth', () => {
    const root = join(__dirname, '..');
    const routeFiles = (dir: string): string[] =>
      readdirSync(dir).flatMap((entry) => {
        if (entry === '__tests__') return [];
        const full = join(dir, entry);
        return statSync(full).isDirectory() ? routeFiles(full) : entry === 'route.ts' ? [full] : [];
      });
    const bound = routeFiles(root)
      .filter((file) => /allow:\s*\[[^\]]*'oauth'/.test(readFileSync(file, 'utf8')))
      .map((file) => ({ route: relative(root, file).split(sep).slice(0, -1).join('/') || '.', usesRule: readFileSync(file, 'utf8').includes("personal-event-scope'") }))
      .sort((a, b) => a.route.localeCompare(b.route));

    expect(bound).toEqual([
      { route: '.', usesRule: true },
      { route: '[eventId]', usesRule: true },
      { route: '[eventId]/attendees', usesRule: true },
      { route: '[eventId]/drives', usesRule: true },
      { route: '[eventId]/triggers', usesRule: true },
    ]);
  });
});
