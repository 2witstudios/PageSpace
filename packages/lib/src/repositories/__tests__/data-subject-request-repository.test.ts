import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: { dataSubjectRequests: { findFirst: vi.fn() } },
    insert: vi.fn(),
    update: vi.fn(),
    select: vi.fn(),
  },
}));
vi.mock('@pagespace/db/schema/data-subject-requests', () => ({
  dataSubjectRequests: {
    id: 'id',
    userId: 'userId',
    status: 'status',
    attempts: 'attempts',
    stepResults: 'stepResults',
    slaDeadline: 'slaDeadline',
    receivedAt: 'receivedAt',
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(() => 'eq'),
  inArray: vi.fn(() => 'inArray'),
  desc: vi.fn(() => 'desc'),
  sql: Object.assign(
    (parts: TemplateStringsArray, ..._args: unknown[]) => ({ sql: parts.join('?') }),
    { placeholder: vi.fn() }
  ),
}));

import { dataSubjectRequestRepository } from '../data-subject-request-repository';
import { db } from '@pagespace/db/db';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('dataSubjectRequestRepository.create', () => {
  it('given a receivedAt, should persist a 30-day SLA deadline and default to erasure/pending', async () => {
    const returningFn = vi.fn().mockResolvedValue([{ id: 'dsr_1' }]);
    const valuesFn = vi.fn().mockReturnValue({ returning: returningFn });
    vi.mocked(db.insert).mockReturnValue({ values: valuesFn } as never);

    const received = new Date('2026-01-01T00:00:00.000Z');
    await dataSubjectRequestRepository.create({
      userId: 'u1',
      subjectEmail: 'a@b.com',
      receivedAt: received,
    });

    const persisted = valuesFn.mock.calls[0][0];
    expect(persisted.requestType).toBe('erasure');
    expect(persisted.status).toBe('pending');
    expect(persisted.slaDeadline.toISOString()).toBe('2026-01-31T00:00:00.000Z');
    expect(persisted.forceDelete).toBe(false);
  });

  it('given forceDelete, should persist the escalation flag', async () => {
    const returningFn = vi.fn().mockResolvedValue([{ id: 'dsr_2' }]);
    const valuesFn = vi.fn().mockReturnValue({ returning: returningFn });
    vi.mocked(db.insert).mockReturnValue({ values: valuesFn } as never);

    await dataSubjectRequestRepository.create({
      userId: 'u1',
      subjectEmail: 'a@b.com',
      receivedAt: new Date('2026-01-01T00:00:00.000Z'),
      forceDelete: true,
      requestedByType: 'admin',
      requestedByUserId: 'admin1',
    });

    const persisted = valuesFn.mock.calls[0][0];
    expect(persisted.forceDelete).toBe(true);
    expect(persisted.requestedByType).toBe('admin');
    expect(persisted.requestedByUserId).toBe('admin1');
  });
});

describe('dataSubjectRequestRepository.updateStatus', () => {
  it('given a status + patch, should set status, updatedAt and the patch fields', async () => {
    const whereFn = vi.fn().mockResolvedValue(undefined);
    const setFn = vi.fn().mockReturnValue({ where: whereFn });
    vi.mocked(db.update).mockReturnValue({ set: setFn } as never);

    const completedAt = new Date('2026-01-10T00:00:00.000Z');
    await dataSubjectRequestRepository.updateStatus('dsr_1', 'completed', { completedAt });

    const patch = setFn.mock.calls[0][0];
    expect(patch.status).toBe('completed');
    expect(patch.completedAt).toBe(completedAt);
    expect(patch.updatedAt).toBeInstanceOf(Date);
  });
});
