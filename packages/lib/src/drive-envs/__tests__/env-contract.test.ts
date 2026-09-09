import { describe, it, expect } from 'vitest';
import { DRIVE_ENV_SUBSTRATES as SCHEMA_SUBSTRATES } from '@pagespace/db/schema/drive-envs';
import {
  createDriveEnvRequestSchema,
  driveEnvDtoSchema,
  driveEnvStatusSchema,
  DRIVE_ENV_STATUSES,
  DRIVE_ENV_SUBSTRATES,
  driveEnvSubstrateSchema,
  localEnvEnrollmentIssueSchema,
  patchDriveEnvRequestSchema,
  SERVER_POLICY_OPS,
  driveEnvApprovalDtoSchema,
} from '../env-contract';
import { GRANT_OPS } from '../../env-bridge/grant';

const BASE_DTO = { id: 'env_1', driveId: 'drive_1', name: 'dev', substrate: 'sprite', status: 'none', createdAt: '2026-09-04T00:00:00.000Z' };

describe('drive-env contract — the substrate axis (Local Environments epic)', () => {
  describe('driveEnvDtoSchema — the local variant exposes the server policy (what PageSpace may ask the machine to do)', () => {
    const localDto = { ...BASE_DTO, substrate: 'local', status: 'disconnected', label: 'mac', enrolled: false, ownerId: 'u1', capabilities: null, paused: false };

    it('given a local DTO with a serverPolicy, should accept', () => {
      expect(driveEnvDtoSchema.safeParse({ ...localDto, serverPolicy: { ops: ['fs_read', 'fs_write'], checkpoint: false } }).success).toBe(true);
    });

    it('carries the owner and the advertised capabilities (GA wave 3): both required, both nullable — a dead row has no owner, a never-connected machine no hello', () => {
      const policy = { ops: [], checkpoint: false };
      expect(driveEnvDtoSchema.safeParse({ ...localDto, serverPolicy: policy, ownerId: null }).success).toBe(true);
      expect(driveEnvDtoSchema.safeParse({ ...localDto, serverPolicy: policy, capabilities: { shell: true, pty: false, fs: true, checkpoint: false } }).success).toBe(true);
      const { ownerId: _o, ...noOwner } = { ...localDto, serverPolicy: policy };
      expect(driveEnvDtoSchema.safeParse(noOwner).success).toBe(false);
      const { capabilities: _c, ...noCaps } = { ...localDto, serverPolicy: policy };
      expect(driveEnvDtoSchema.safeParse(noCaps).success).toBe(false);
      // A Sprite DTO never carries either.
      expect(driveEnvDtoSchema.parse(BASE_DTO)).not.toHaveProperty('ownerId');
    });

    it('carries `paused` (Stop, GA wave 3): required on the local variant, absent on a Sprite DTO', () => {
      const policy = { ops: [], checkpoint: false };
      const { paused: _p, ...noPaused } = { ...localDto, serverPolicy: policy };
      expect(driveEnvDtoSchema.safeParse(noPaused).success).toBe(false);
      expect(driveEnvDtoSchema.parse({ ...localDto, serverPolicy: policy, paused: true })).toMatchObject({ paused: true });
      expect(driveEnvDtoSchema.parse(BASE_DTO)).not.toHaveProperty('paused');
    });

    it('given a local DTO WITHOUT a serverPolicy, should reject — a settings page cannot render a policy it was not given', () => {
      expect(driveEnvDtoSchema.safeParse(localDto).success).toBe(false);
    });

    it('given a Sprite DTO with a stray serverPolicy, should drop it (a Sprite has none; unknown keys are stripped, not refused)', () => {
      const parsed = driveEnvDtoSchema.parse({ ...BASE_DTO, serverPolicy: { ops: [], checkpoint: false } });
      expect('serverPolicy' in parsed).toBe(false);
    });
  });

  it('exposes the closed substrate set and a schema for it', () => {
    expect([...DRIVE_ENV_SUBSTRATES]).toEqual(['sprite', 'local']);
    expect(driveEnvSubstrateSchema.safeParse('sprite').success).toBe(true);
    expect(driveEnvSubstrateSchema.safeParse('local').success).toBe(true);
    expect(driveEnvSubstrateSchema.safeParse('modal').success).toBe(false);
  });

  it('keeps its substrate set identical to the schema\'s — the contract is a zod-only module for browser clients, so the set is declared twice and must be pinned once', () => {
    expect([...DRIVE_ENV_SUBSTRATES]).toEqual([...SCHEMA_SUBSTRATES]);
  });

  describe('createDriveEnvRequestSchema', () => {
    it('given just a name, should default substrate to sprite (existing clients are unchanged)', () => {
      expect(createDriveEnvRequestSchema.parse({ name: 'dev' })).toEqual({ name: 'dev', substrate: 'sprite' });
    });

    it("given substrate local WITHOUT a label, should reject (a local env needs the machine's human name)", () => {
      expect(createDriveEnvRequestSchema.safeParse({ name: 'mac', substrate: 'local' }).success).toBe(false);
    });

    it('given substrate local WITH a label and an explicit serverPolicy, should accept and keep the trimmed label', () => {
      expect(createDriveEnvRequestSchema.parse({ name: 'mac', substrate: 'local', label: '  jono-macstudio ', serverPolicy: { ops: ['fs_read', 'fs_write'], checkpoint: false } })).toEqual({
        name: 'mac',
        substrate: 'local',
        label: 'jono-macstudio',
        serverPolicy: { ops: ['fs_read', 'fs_write'], checkpoint: false },
      });
    });

    describe('serverPolicy — REQUIRED for a local env (GA wave 1: the column default is a backstop, never a path)', () => {
      const local = { name: 'mac', substrate: 'local', label: 'mac' };

      it('given substrate local WITHOUT a serverPolicy, should reject — the dialog must say what the machine may do', () => {
        const result = createDriveEnvRequestSchema.safeParse(local);
        expect(result.success).toBe(false);
        if (!result.success) expect(result.error.issues.map((issue) => String(issue.path[0]))).toContain('serverPolicy');
      });

      it('given an op outside GRANT_OPS, should reject', () => {
        expect(createDriveEnvRequestSchema.safeParse({ ...local, serverPolicy: { ops: ['exec', 'rm_rf'], checkpoint: false } }).success).toBe(false);
      });

      it('given checkpoint true, should reject — a local machine never advertises checkpoints (invariant 12)', () => {
        expect(createDriveEnvRequestSchema.safeParse({ ...local, serverPolicy: { ops: ['fs_read'], checkpoint: true } }).success).toBe(false);
      });

      it('SERVER_POLICY_OPS is the IMPLEMENTED subset of GRANT_OPS (the wire vocabulary) — pty_open is not in it until M2 lands PTY', () => {
        expect([...SERVER_POLICY_OPS]).toEqual(['exec', 'fs_read', 'fs_write']);
        for (const op of SERVER_POLICY_OPS) expect(GRANT_OPS).toContain(op);
        expect([...SERVER_POLICY_OPS]).not.toContain('pty_open');
      });

      it('given a pty_open-only policy, should reject — a bindable env that can do nothing is refused at the boundary (Codex P2)', () => {
        expect(createDriveEnvRequestSchema.safeParse({ ...local, serverPolicy: { ops: ['pty_open'], checkpoint: false } }).success).toBe(false);
      });

      it('given pty_open mixed into an otherwise valid policy, should reject too', () => {
        expect(createDriveEnvRequestSchema.safeParse({ ...local, serverPolicy: { ops: ['fs_read', 'pty_open'], checkpoint: false } }).success).toBe(false);
        expect(patchDriveEnvRequestSchema.safeParse({ serverPolicy: { ops: ['exec', 'pty_open'], checkpoint: false } }).success).toBe(false);
      });

      it('given a stray field in serverPolicy, should reject (closed shape)', () => {
        expect(createDriveEnvRequestSchema.safeParse({ ...local, serverPolicy: { ops: ['fs_read'], checkpoint: false, roots: ['/'] } }).success).toBe(false);
      });

      it('given an EMPTY ops list, should accept — an owner may mint a machine that does nothing yet and enable ops later', () => {
        expect(createDriveEnvRequestSchema.parse({ ...local, serverPolicy: { ops: [], checkpoint: false } })).toMatchObject({ serverPolicy: { ops: [], checkpoint: false } });
      });

      it('given duplicated ops, should keep each once', () => {
        expect(createDriveEnvRequestSchema.parse({ ...local, serverPolicy: { ops: ['exec', 'exec', 'fs_read'], checkpoint: false } })).toMatchObject({ serverPolicy: { ops: ['exec', 'fs_read'] } });
      });

      it('given substrate sprite WITH a serverPolicy, should drop it (a Sprite has no server policy)', () => {
        expect(createDriveEnvRequestSchema.parse({ name: 'dev', substrate: 'sprite', serverPolicy: { ops: ['exec'], checkpoint: false } })).toEqual({ name: 'dev', substrate: 'sprite' });
      });
    });

    it('given substrate sprite WITH a label, should accept and drop the label (it means nothing for a Sprite)', () => {
      expect(createDriveEnvRequestSchema.parse({ name: 'dev', substrate: 'sprite', label: 'x' })).toEqual({ name: 'dev', substrate: 'sprite' });
    });

    it('given an unknown substrate, should reject', () => {
      expect(createDriveEnvRequestSchema.safeParse({ name: 'x', substrate: 'modal' }).success).toBe(false);
    });

    it('given a blank or over-long label for a local env, should reject', () => {
      expect(createDriveEnvRequestSchema.safeParse({ name: 'x', substrate: 'local', label: '   ' }).success).toBe(false);
      expect(createDriveEnvRequestSchema.safeParse({ name: 'x', substrate: 'local', label: 'a'.repeat(200) }).success).toBe(false);
    });
  });

  describe('localEnvEnrollmentIssueSchema — the one-time code on the wire', () => {
    it('should carry the enrollment id, the code, and an ISO expiry; nothing may be blank', () => {
      expect(localEnvEnrollmentIssueSchema.safeParse({ enrollmentId: 'enr_1', code: 'ABCDEFGHJKMNPQRSTVWX', expiresAt: '2026-09-05T10:00:00.000Z' }).success).toBe(true);
      expect(localEnvEnrollmentIssueSchema.safeParse({ enrollmentId: 'enr_1', code: '', expiresAt: '2026-09-05T10:00:00.000Z' }).success).toBe(false);
      expect(localEnvEnrollmentIssueSchema.safeParse({ enrollmentId: 'enr_1', code: 'x', expiresAt: 'tomorrow' }).success).toBe(false);
    });
  });

  describe('driveEnvDtoSchema / status vocabulary', () => {
    it('carries substrate on every DTO', () => {
      expect(driveEnvDtoSchema.parse(BASE_DTO).substrate).toBe('sprite');
      expect(driveEnvDtoSchema.safeParse({ ...BASE_DTO, substrate: undefined }).success).toBe(false);
    });

    it('adds the derived local statuses (connecting|connected|disconnected) alongside the Sprite ones', () => {
      expect([...DRIVE_ENV_STATUSES]).toEqual(['none', 'running', 'stopped', 'connecting', 'connected', 'disconnected']);
      for (const s of DRIVE_ENV_STATUSES) expect(driveEnvStatusSchema.safeParse(s).success).toBe(true);
    });

    it('given a local env, should reject a Sprite-only status, and vice versa (the vocabularies do not mix)', () => {
      expect(driveEnvDtoSchema.safeParse({ ...BASE_DTO, substrate: 'local', status: 'running' }).success).toBe(false);
      expect(driveEnvDtoSchema.safeParse({ ...BASE_DTO, substrate: 'sprite', status: 'connected' }).success).toBe(false);
      expect(driveEnvDtoSchema.safeParse({ ...BASE_DTO, substrate: 'local', status: 'connected', label: 'm', enrolled: true, serverPolicy: { ops: [], checkpoint: false }, ownerId: 'u1', capabilities: null, paused: false }).success).toBe(true);
    });

    it('given a local env DTO, should carry the label AND whether a machine has enrolled — the fact the UI needs to offer a new code only while none has', () => {
      const dto = driveEnvDtoSchema.parse({ ...BASE_DTO, substrate: 'local', status: 'disconnected', label: 'jono-macstudio', enrolled: false, serverPolicy: { ops: [], checkpoint: false }, ownerId: 'u1', capabilities: null, paused: false });
      expect(dto.substrate).toBe('local');
      if (dto.substrate === 'local') {
        expect(dto.label).toBe('jono-macstudio');
        expect(dto.enrolled).toBe(false);
      }
      expect(driveEnvDtoSchema.safeParse({ ...BASE_DTO, substrate: 'local', status: 'disconnected', enrolled: false }).success).toBe(false);
      expect(driveEnvDtoSchema.safeParse({ ...BASE_DTO, substrate: 'local', status: 'disconnected', label: 'm' }).success).toBe(false);
    });
  });

  describe('patchDriveEnvRequestSchema — two fields, two rules, ONE per request (GA wave 1)', () => {
    it('given just a name, should accept (the rename, owner-or-admin at the route)', () => {
      expect(patchDriveEnvRequestSchema.parse({ name: ' prod ' })).toEqual({ name: 'prod' });
    });

    it('given just a serverPolicy, should accept (owner-only at the route)', () => {
      expect(patchDriveEnvRequestSchema.parse({ serverPolicy: { ops: ['exec', 'exec'], checkpoint: false } })).toEqual({ serverPolicy: { ops: ['exec'], checkpoint: false } });
        // Stop / Resume (GA wave 3): a THIRD exclusive field, a boolean and nothing else.
        expect(patchDriveEnvRequestSchema.parse({ paused: true })).toEqual({ paused: true });
        expect(patchDriveEnvRequestSchema.parse({ paused: false })).toEqual({ paused: false });
        expect(patchDriveEnvRequestSchema.safeParse({ paused: 'true' }).success).toBe(false);
        expect(patchDriveEnvRequestSchema.safeParse({ paused: true, name: 'x' }).success).toBe(false);
        expect(patchDriveEnvRequestSchema.safeParse({ paused: true, serverPolicy: { ops: [], checkpoint: false } }).success).toBe(false);
    });

    it('given BOTH fields, should reject — two rules cannot be answered by one status code', () => {
      expect(patchDriveEnvRequestSchema.safeParse({ name: 'prod', serverPolicy: { ops: [], checkpoint: false } }).success).toBe(false);
    });

    it('given NEITHER field, should reject', () => {
      expect(patchDriveEnvRequestSchema.safeParse({}).success).toBe(false);
    });

    it('given an invalid serverPolicy (checkpoint true, or an op outside the set), should reject', () => {
      expect(patchDriveEnvRequestSchema.safeParse({ serverPolicy: { ops: ['exec'], checkpoint: true } }).success).toBe(false);
      expect(patchDriveEnvRequestSchema.safeParse({ serverPolicy: { ops: ['shell'], checkpoint: false } }).success).toBe(false);
    });
  });
});

describe('driveEnvApprovalDtoSchema (GA wave 3) — a mirrored approval carries revokePending', () => {
  it('requires revokePending alongside the two revoke timestamps', () => {
    const base = { id: 'ch_1', envId: 'e', driveId: null, envName: null, envLabel: null, userId: 'u', op: 'exec', summary: 's', scope: '30d', createdAt: '2026-09-09T12:00:00.000Z', expiresAt: null, revokedAt: null, revokeAcknowledgedAt: null };
    expect(driveEnvApprovalDtoSchema.safeParse(base).success).toBe(false);
    expect(driveEnvApprovalDtoSchema.parse({ ...base, revokePending: true })).toMatchObject({ revokePending: true });
  });
});
