/**
 * Per-service Admin PG LOGIN users — pure planning + SQL building (#890
 * Phase 2, leaf 0). No I/O, no process.env reads; provision-admin-users.ts is
 * the executing shell.
 *
 * drizzle-admin/0001 created NOLOGIN role TEMPLATES (admin_app,
 * admin_chainer, admin_siem, admin_reader, …). Runtime services must never
 * connect as the database owner (it bypasses every zero-trust grant), so each
 * service gets its own LOGIN user attached to its template role(s):
 *
 *   login user             granted templates            used by
 *   admin_app_user         admin_app                    web (audit emission)
 *   admin_processor_user   admin_chainer, admin_siem    processor (chainer + SIEM workers)
 *   admin_reader_user      admin_reader                 admin app (read-only)
 *   admin_gdpr_eraser_user admin_gdpr_eraser            web GDPR pseudonymization route
 *                                                       (Art 17 — column-scoped UPDATE on
 *                                                       exactly the 6 PII columns; leaf 6)
 *
 * Provisioning is idempotent and rotation-safe: CREATE is guarded, ALTER
 * always (re)sets LOGIN + password + least-privilege attributes, GRANT is
 * natively idempotent. Passwords come from env (ADMIN_APP_PASSWORD etc.);
 * an unset var skips that user, a set-but-invalid one refuses the whole run.
 */

export interface AdminLoginUserSpec {
  user: string;
  envVar: keyof AdminLoginUserEnv;
  roles: string[];
}

export interface AdminLoginUserEnv {
  ADMIN_APP_PASSWORD?: string | undefined;
  ADMIN_PROCESSOR_PASSWORD?: string | undefined;
  ADMIN_READER_PASSWORD?: string | undefined;
  ADMIN_ERASER_PASSWORD?: string | undefined;
}

export const ADMIN_LOGIN_USERS: readonly AdminLoginUserSpec[] = [
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
];

export interface AdminLoginUserProvision {
  user: string;
  roles: string[];
  password: string;
}

export type AdminLoginUserPlan =
  | { ok: true; provision: AdminLoginUserProvision[]; skipped: string[] }
  | { ok: false; reason: string };

const MIN_PASSWORD_LENGTH = 8;

// Quote-escaping below guarantees literal-safety only under
// standard_conforming_strings (on by default since PG 9.1) and only for
// values free of backslashes and control characters — so those are rejected
// outright, along with whitespace (never legitimate in generated secrets).
const passwordProblem = (value: string): string | null => {
  if (value.length === 0) return 'is set but empty';
  if (value.length < MIN_PASSWORD_LENGTH) return `is shorter than ${MIN_PASSWORD_LENGTH} characters`;
  // eslint-disable-next-line no-control-regex
  if (/[\s\\\x00-\x1f\x7f]/.test(value)) {
    return 'contains whitespace, a backslash, or a control character';
  }
  return null;
};

/**
 * Decide which LOGIN users to provision from the given env. Unset password →
 * that user is skipped (named in `skipped`); set-but-invalid password → the
 * whole plan refuses (a blank/garbled credential is a misconfigured deploy).
 * Reasons never echo the password value.
 */
export const planAdminLoginUsers = (env: AdminLoginUserEnv): AdminLoginUserPlan => {
  const provision: AdminLoginUserProvision[] = [];
  const skipped: string[] = [];

  for (const spec of ADMIN_LOGIN_USERS) {
    const password = env[spec.envVar];
    if (password === undefined) {
      skipped.push(spec.user);
      continue;
    }
    const problem = passwordProblem(password);
    if (problem) {
      return {
        ok: false,
        reason: `${spec.envVar} ${problem} — fix the deploy env; admin login users were NOT provisioned`,
      };
    }
    provision.push({ user: spec.user, roles: [...spec.roles], password });
  }

  return { ok: true, provision, skipped };
};

const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

const assertSafeIdentifier = (name: string, kind: string): void => {
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new Error(`unsafe ${kind} identifier: ${JSON.stringify(name)}`);
  }
};

/**
 * Quote a value as a Postgres string literal: wrap in single quotes, double
 * embedded quotes. Throws on backslashes and control characters — under
 * standard_conforming_strings those are the only escape hatches left, and
 * refusing them keeps this function injection-safe by construction.
 */
export const quotePgLiteral = (value: string): string => {
  // eslint-disable-next-line no-control-regex
  if (/[\\\x00-\x1f\x7f]/.test(value)) {
    throw new Error('quotePgLiteral: value contains a backslash or control character');
  }
  return `'${value.split("'").join("''")}'`;
};

/**
 * Every template role the provisioner manages — the universe stale
 * memberships are revoked from when a user's template set changes.
 */
export const ADMIN_MANAGED_TEMPLATE_ROLES: readonly string[] = [
  ...new Set(ADMIN_LOGIN_USERS.flatMap((spec) => spec.roles)),
];

/**
 * SQL statements provisioning one LOGIN user: guarded CREATE (roles are
 * cluster-scoped and may pre-exist), an ALTER that unconditionally (re)sets
 * LOGIN + password + least-privilege attributes (so re-running rotates the
 * password and repairs drifted attributes), one REVOKE per managed template
 * role the entry does NOT hold (GRANT only adds — without this a template
 * change would leave the old membership in place forever), then one GRANT
 * per template role.
 */
export const buildLoginUserStatements = (entry: AdminLoginUserProvision): string[] => {
  assertSafeIdentifier(entry.user, 'login user');
  for (const role of entry.roles) {
    assertSafeIdentifier(role, 'role');
  }

  const create = [
    'DO $$',
    'BEGIN',
    `  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${entry.user}') THEN`,
    `    CREATE ROLE ${entry.user};`,
    '  END IF;',
    'END',
    '$$',
  ].join('\n');

  const alter =
    `ALTER ROLE ${entry.user} WITH LOGIN PASSWORD ${quotePgLiteral(entry.password)} ` +
    'NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT';

  const stale = ADMIN_MANAGED_TEMPLATE_ROLES.filter((role) => !entry.roles.includes(role));

  return [
    create,
    alter,
    ...stale.map((role) => `REVOKE ${role} FROM ${entry.user}`),
    ...entry.roles.map((role) => `GRANT ${role} TO ${entry.user}`),
  ];
};
