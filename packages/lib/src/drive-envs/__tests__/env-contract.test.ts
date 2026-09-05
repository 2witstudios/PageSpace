import { describe, it, expect } from 'vitest';
import { DRIVE_ENV_SUBSTRATES as SCHEMA_SUBSTRATES } from '@pagespace/db/schema/drive-envs';
import {
  createDriveEnvRequestSchema,
  driveEnvDtoSchema,
  driveEnvStatusSchema,
  DRIVE_ENV_STATUSES,
  DRIVE_ENV_SUBSTRATES,
  driveEnvSubstrateSchema,
} from '../env-contract';

const BASE_DTO = { id: 'env_1', driveId: 'drive_1', name: 'dev', substrate: 'sprite', status: 'none', createdAt: '2026-09-04T00:00:00.000Z' };

describe('drive-env contract — the substrate axis (Local Environments epic)', () => {
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

    it('given substrate local WITH a label, should accept and keep the trimmed label', () => {
      expect(createDriveEnvRequestSchema.parse({ name: 'mac', substrate: 'local', label: '  jono-macstudio ' })).toEqual({ name: 'mac', substrate: 'local', label: 'jono-macstudio' });
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
      expect(driveEnvDtoSchema.safeParse({ ...BASE_DTO, substrate: 'local', status: 'connected', label: 'm' }).success).toBe(true);
    });

    it('given a local env DTO, should carry the label', () => {
      const dto = driveEnvDtoSchema.parse({ ...BASE_DTO, substrate: 'local', status: 'disconnected', label: 'jono-macstudio' });
      expect(dto.substrate).toBe('local');
      if (dto.substrate === 'local') expect(dto.label).toBe('jono-macstudio');
      expect(driveEnvDtoSchema.safeParse({ ...BASE_DTO, substrate: 'local', status: 'disconnected' }).success).toBe(false);
    });
  });
});
