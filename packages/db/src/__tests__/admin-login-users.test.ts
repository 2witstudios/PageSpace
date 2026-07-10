/**
 * Pure planning + SQL-building tests for per-service Admin PG LOGIN users
 * (#890 Phase 2, leaf 0 — gate).
 *
 * drizzle-admin/0001 created NOLOGIN role TEMPLATES; actual login users are
 * provisioned per-deploy from env passwords and attached with GRANT. All the
 * logic (which users, validation, SQL text, literal escaping) is pure and
 * pinned here; provision-admin-users.ts is the thin shell.
 */
import { describe, it, expect } from 'vitest';
import {
  ADMIN_LOGIN_USERS,
  planAdminLoginUsers,
  buildLoginUserStatements,
  quotePgLiteral,
  type AdminLoginUserEnv,
} from '../admin-login-users';

const ALL_PASSWORDS: AdminLoginUserEnv = {
  ADMIN_APP_PASSWORD: 'app-password-123',
  ADMIN_PROCESSOR_PASSWORD: 'processor-password-123',
  ADMIN_READER_PASSWORD: 'reader-password-123',
  ADMIN_ERASER_PASSWORD: 'eraser-password-123',
};

describe('ADMIN_LOGIN_USERS (the per-service identity matrix)', () => {
  it('given the matrix, should map web to admin_app, processor to admin_chainer+admin_siem, admin app to admin_reader, GDPR erasure to admin_gdpr_eraser', () => {
    expect(ADMIN_LOGIN_USERS).toEqual([
      { user: 'admin_app_user', envVar: 'ADMIN_APP_PASSWORD', roles: ['admin_app'] },
      {
        user: 'admin_processor_user',
        envVar: 'ADMIN_PROCESSOR_PASSWORD',
        roles: ['admin_chainer', 'admin_siem'],
      },
      { user: 'admin_reader_user', envVar: 'ADMIN_READER_PASSWORD', roles: ['admin_reader'] },
      {
        user: 'admin_gdpr_eraser_user',
        envVar: 'ADMIN_ERASER_PASSWORD',
        roles: ['admin_gdpr_eraser'],
      },
    ]);
  });

  it('given every user and role name, should be a safe lowercase SQL identifier (they are interpolated unquoted)', () => {
    for (const spec of ADMIN_LOGIN_USERS) {
      expect(spec.user).toMatch(/^[a-z_][a-z0-9_]*$/);
      for (const role of spec.roles) {
        expect(role).toMatch(/^[a-z_][a-z0-9_]*$/);
      }
    }
  });
});

describe('planAdminLoginUsers', () => {
  it('given all four passwords set, should provision all four users with their template roles', () => {
    const plan = planAdminLoginUsers(ALL_PASSWORDS);
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.provision.map((p) => p.user)).toEqual([
        'admin_app_user',
        'admin_processor_user',
        'admin_reader_user',
        'admin_gdpr_eraser_user',
      ]);
      expect(plan.skipped).toEqual([]);
      expect(plan.provision[1]!.roles).toEqual(['admin_chainer', 'admin_siem']);
      expect(plan.provision[0]!.password).toBe('app-password-123');
      expect(plan.provision[3]!.roles).toEqual(['admin_gdpr_eraser']);
    }
  });

  it('given a password env var that is unset, should skip that user (and name it) without failing the others', () => {
    const plan = planAdminLoginUsers({
      ADMIN_APP_PASSWORD: 'app-password-123',
      ADMIN_PROCESSOR_PASSWORD: 'processor-password-123',
    });
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.provision.map((p) => p.user)).toEqual([
        'admin_app_user',
        'admin_processor_user',
      ]);
      expect(plan.skipped).toEqual(['admin_reader_user', 'admin_gdpr_eraser_user']);
    }
  });

  it('given no passwords at all, should return an empty plan (nothing to provision is not an error)', () => {
    const plan = planAdminLoginUsers({});
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.provision).toEqual([]);
      expect(plan.skipped).toEqual([
        'admin_app_user',
        'admin_processor_user',
        'admin_reader_user',
        'admin_gdpr_eraser_user',
      ]);
    }
  });

  it('given a set-but-empty password, should refuse — a blank credential is a misconfigured deploy, never a skip', () => {
    const plan = planAdminLoginUsers({ ...ALL_PASSWORDS, ADMIN_APP_PASSWORD: '' });
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.reason).toContain('ADMIN_APP_PASSWORD');
    }
  });

  it('given a password shorter than 8 characters, should refuse and name the env var (never the value)', () => {
    const plan = planAdminLoginUsers({ ...ALL_PASSWORDS, ADMIN_READER_PASSWORD: 'pw12345' });
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.reason).toContain('ADMIN_READER_PASSWORD');
      expect(plan.reason).not.toContain('pw12345');
    }
  });

  it('given a password containing whitespace or control characters, should refuse without echoing the value', () => {
    for (const bad of ['pass word-123', 'pass\nword-123', 'pass\x00word-123']) {
      const plan = planAdminLoginUsers({ ...ALL_PASSWORDS, ADMIN_PROCESSOR_PASSWORD: bad });
      expect(plan.ok).toBe(false);
      if (!plan.ok) {
        expect(plan.reason).toContain('ADMIN_PROCESSOR_PASSWORD');
        expect(plan.reason).not.toContain(bad);
      }
    }
  });

  it('given a password containing a backslash, should refuse (escaping only guarantees quote-safety under standard_conforming_strings)', () => {
    const plan = planAdminLoginUsers({ ...ALL_PASSWORDS, ADMIN_APP_PASSWORD: 'back\\slash-123' });
    expect(plan.ok).toBe(false);
  });

  it('given an invalid ADMIN_ERASER_PASSWORD, should refuse the whole plan naming the eraser env var', () => {
    const plan = planAdminLoginUsers({ ...ALL_PASSWORDS, ADMIN_ERASER_PASSWORD: 'short' });
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.reason).toContain('ADMIN_ERASER_PASSWORD');
    }
  });
});

describe('quotePgLiteral', () => {
  it('given a plain value, should wrap it in single quotes', () => {
    expect(quotePgLiteral('abc123')).toBe("'abc123'");
  });

  it('given embedded single quotes, should double them (injection-safe)', () => {
    expect(quotePgLiteral("o'brien'); DROP ROLE admin_app; --")).toBe(
      "'o''brien''); DROP ROLE admin_app; --'",
    );
  });

  it('given a backslash or control character, should throw rather than emit ambiguous SQL', () => {
    expect(() => quotePgLiteral('a\\b')).toThrow();
    expect(() => quotePgLiteral('a\x00b')).toThrow();
    expect(() => quotePgLiteral('a\nb')).toThrow();
  });
});

describe('buildLoginUserStatements', () => {
  const entry = {
    user: 'admin_app_user',
    roles: ['admin_app'],
    password: "pw'quote-123",
  };

  it('given an entry, should emit guarded CREATE, an ALTER that always (re)sets LOGIN + password, then one GRANT per role', () => {
    const statements = buildLoginUserStatements(entry);
    expect(statements).toHaveLength(3);
    expect(statements[0]).toContain("IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'admin_app_user')");
    expect(statements[0]).toContain('CREATE ROLE admin_app_user');
    expect(statements[1]).toContain('ALTER ROLE admin_app_user WITH LOGIN');
    expect(statements[2]).toBe('GRANT admin_app TO admin_app_user');
  });

  it('given the ALTER, should pin least-privilege attributes and INHERIT (template privileges apply without SET ROLE)', () => {
    const alter = buildLoginUserStatements(entry)[1]!;
    for (const attr of ['NOSUPERUSER', 'NOCREATEDB', 'NOCREATEROLE', 'NOREPLICATION', 'NOBYPASSRLS', 'INHERIT']) {
      expect(alter).toContain(attr);
    }
    expect(alter).not.toMatch(/\bSUPERUSER\b/);
  });

  it('given the password, should embed it via quotePgLiteral (quotes doubled)', () => {
    const alter = buildLoginUserStatements(entry)[1]!;
    expect(alter).toContain("PASSWORD 'pw''quote-123'");
  });

  it('given a multi-role entry, should grant every template role', () => {
    const statements = buildLoginUserStatements({
      user: 'admin_processor_user',
      roles: ['admin_chainer', 'admin_siem'],
      password: 'processor-password-123',
    });
    expect(statements).toContain('GRANT admin_chainer TO admin_processor_user');
    expect(statements).toContain('GRANT admin_siem TO admin_processor_user');
  });

  it('given a user or role name that is not a safe identifier, should throw', () => {
    expect(() =>
      buildLoginUserStatements({ user: 'bad"user', roles: ['admin_app'], password: 'x-123456' }),
    ).toThrow();
    expect(() =>
      buildLoginUserStatements({ user: 'admin_app_user', roles: ['admin app'], password: 'x-123456' }),
    ).toThrow();
  });
});
