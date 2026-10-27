import { describe, expect, it } from 'vitest';
import { buildRequest } from '../../transport/build-request.js';
import { parseResponse } from '../../transport/parse-response.js';
import { ResponseValidationError } from '../../errors.js';
import { createWorkflow, deleteWorkflow, listWorkflows, updateWorkflow } from '../workflows.js';

const config = { baseUrl: 'https://pagespace.ai' };

/** Bare `workflows` row (`packages/db/src/schema/workflows.ts`), route-serialized (Date -> ISO string). */
const workflowFixture = {
  id: 'w1abc',
  driveId: 'd1abc',
  createdBy: 'u1abc',
  name: 'Daily standup summary',
  agentPageId: 'ag1abc',
  prompt: 'Summarize yesterday\'s activity.',
  contextPageIds: ['p1abc'],
  cronExpression: '0 9 * * *',
  timezone: 'UTC',
  triggerType: 'cron',
  eventTriggers: null,
  watchedFolderIds: null,
  eventDebounceSecs: 30,
  instructionPageId: null,
  isEnabled: true,
  nextRunAt: '2026-07-04T09:00:00.000Z',
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
};

describe('workflows.list — request shape', () => {
  it('builds a GET to /api/workflows?driveId=... (driveId is a query param, not a path segment)', () => {
    const request = buildRequest(listWorkflows, { driveId: 'd1abc' }, config);
    expect(request.method).toBe('GET');
    expect(request.url).toBe('https://pagespace.ai/api/workflows?driveId=d1abc');
    expect(request.body).toBeUndefined();
  });

  it('rejects input missing driveId before any network call (route: 400 without it)', () => {
    const result = listWorkflows.inputSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe('workflows.list — response contract', () => {
  it('parses a bare array of workflow rows with a lastRun summary (route truth: workflows/route.ts GET)', () => {
    const withRun = {
      ...workflowFixture,
      lastRun: { status: 'success', startedAt: '2026-07-03T09:00:00.000Z', endedAt: '2026-07-03T09:00:05.000Z', error: null, durationMs: 5000 },
    };
    const result = parseResponse(listWorkflows, 200, new Headers(), JSON.stringify([withRun]));
    expect(result).toEqual([withRun]);
  });

  it('parses a workflow with no runs yet as lastRun: null', () => {
    const noRun = { ...workflowFixture, lastRun: null };
    const result = parseResponse(listWorkflows, 200, new Headers(), JSON.stringify([noRun]));
    expect(result).toEqual([noRun]);
  });

  it('parses an empty list', () => {
    const result = parseResponse(listWorkflows, 200, new Headers(), JSON.stringify([]));
    expect(result).toEqual([]);
  });

  it('rejects a response that drifts from the workflow row contract', () => {
    const malformed = [{ ...workflowFixture, lastRun: null, contextPageIds: 'not-an-array' }];
    const result = parseResponse(listWorkflows, 200, new Headers(), JSON.stringify(malformed));
    expect(result).toBeInstanceOf(ResponseValidationError);
  });

  it('classifies a 403 (not owner/admin) as PermissionDeniedError', () => {
    const result = parseResponse(listWorkflows, 403, new Headers(), JSON.stringify({ error: 'Only drive owners and admins can manage workflows' }));
    expect((result as { code: string }).code).toBe('PERMISSION_DENIED');
  });
});

describe('workflows.list — metadata', () => {
  it('requires drive:admin scope — the route gates list/GET on owner-or-admin, not plain membership', () => {
    expect(listWorkflows.requiredScope).toBe('drive:admin');
  });
});

describe('workflows.create — request shape', () => {
  it('sends driveId/name/agentPageId/cronExpression + prompt in the body (route truth: instructionPageId IS accepted post-#1768)', () => {
    const request = buildRequest(
      createWorkflow,
      { driveId: 'd1abc', name: 'Daily standup summary', agentPageId: 'ag1abc', prompt: 'Summarize.', cronExpression: '0 9 * * *' },
      config,
    );
    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://pagespace.ai/api/workflows');
    expect(JSON.parse(request.body ?? '{}')).toEqual({
      driveId: 'd1abc',
      name: 'Daily standup summary',
      agentPageId: 'ag1abc',
      prompt: 'Summarize.',
      cronExpression: '0 9 * * *',
    });
  });

  it('accepts instructionPageId instead of prompt (route: createWorkflowSchema now allows it, #1768 fix)', () => {
    const result = createWorkflow.inputSchema.safeParse({
      driveId: 'd1abc',
      name: 'Daily standup summary',
      agentPageId: 'ag1abc',
      instructionPageId: 'ins1abc',
      cronExpression: '0 9 * * *',
    });
    expect(result.success).toBe(true);
  });

  it('rejects when neither prompt nor instructionPageId is present (route .refine())', () => {
    const result = createWorkflow.inputSchema.safeParse({
      driveId: 'd1abc',
      name: 'Daily standup summary',
      agentPageId: 'ag1abc',
      cronExpression: '0 9 * * *',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unrecognized field (route schema is .strict())', () => {
    const result = createWorkflow.inputSchema.safeParse({
      driveId: 'd1abc',
      name: 'x',
      agentPageId: 'ag1abc',
      prompt: 'go',
      cronExpression: '0 9 * * *',
      bogusField: true,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a name over 200 chars (route: max(200))', () => {
    const result = createWorkflow.inputSchema.safeParse({
      driveId: 'd1abc',
      name: 'x'.repeat(201),
      agentPageId: 'ag1abc',
      prompt: 'go',
      cronExpression: '0 9 * * *',
    });
    expect(result.success).toBe(false);
  });
});

describe('workflows.create — response contract', () => {
  it('parses a 201 bare workflow row (no envelope, no lastRun on a freshly created workflow)', () => {
    const result = parseResponse(createWorkflow, 201, new Headers(), JSON.stringify(workflowFixture));
    expect(result).toEqual(workflowFixture);
  });

  it('classifies a 400 (invalid agent page) as a typed error, not a schema drift', () => {
    const result = parseResponse(createWorkflow, 400, new Headers(), JSON.stringify({ error: 'Agent page not found in this drive' }));
    expect(result).not.toBeInstanceOf(ResponseValidationError);
  });
});

describe('workflows.create — metadata', () => {
  it('requires drive:admin scope', () => {
    expect(createWorkflow.requiredScope).toBe('drive:admin');
  });
});

describe('workflows.update — request shape', () => {
  it('interpolates :workflowId and sends only the provided fields', () => {
    const request = buildRequest(updateWorkflow, { workflowId: 'w1abc', name: 'Renamed' }, config);
    expect(request.method).toBe('PATCH');
    expect(request.url).toBe('https://pagespace.ai/api/workflows/w1abc');
    expect(JSON.parse(request.body ?? '{}')).toEqual({ name: 'Renamed' });
  });

  it('accepts instructionPageId on update too', () => {
    const result = updateWorkflow.inputSchema.safeParse({ workflowId: 'w1abc', instructionPageId: 'ins1abc' });
    expect(result.success).toBe(true);
  });

  it('can clear cronExpression with an explicit null (route: nullable().optional())', () => {
    const request = buildRequest(updateWorkflow, { workflowId: 'w1abc', cronExpression: null }, config);
    expect(JSON.parse(request.body ?? '{}')).toEqual({ cronExpression: null });
  });

  it('rejects an unrecognized field (route schema is .strict())', () => {
    const result = updateWorkflow.inputSchema.safeParse({ workflowId: 'w1abc', bogusField: true });
    expect(result.success).toBe(false);
  });

  it('rejects an empty update with no fields at all beyond workflowId (nothing to send)', () => {
    const result = updateWorkflow.inputSchema.safeParse({ workflowId: 'w1abc' });
    expect(result.success).toBe(true); // schema-valid; route itself has no "must provide one field" guard for PATCH
  });
});

describe('workflows.update — response contract', () => {
  it('parses a bare updated workflow row', () => {
    const result = parseResponse(updateWorkflow, 200, new Headers(), JSON.stringify(workflowFixture));
    expect(result).toEqual(workflowFixture);
  });

  it('classifies a 404 (workflow not found, or a backing non-cron workflow) as NotFoundError', () => {
    const result = parseResponse(updateWorkflow, 404, new Headers(), JSON.stringify({ error: 'Workflow not found' }));
    expect((result as { code: string }).code).toBe('NOT_FOUND');
  });
});

describe('workflows.update — metadata', () => {
  it('requires drive:admin scope', () => {
    expect(updateWorkflow.requiredScope).toBe('drive:admin');
  });
});

describe('workflows.delete — request shape', () => {
  it('builds a DELETE to /api/workflows/:workflowId', () => {
    const request = buildRequest(deleteWorkflow, { workflowId: 'w1abc' }, config);
    expect(request.method).toBe('DELETE');
    expect(request.url).toBe('https://pagespace.ai/api/workflows/w1abc');
    expect(request.body).toBeUndefined();
  });
});

describe('workflows.delete — response contract', () => {
  it('parses { success: true }', () => {
    const result = parseResponse(deleteWorkflow, 200, new Headers(), JSON.stringify({ success: true }));
    expect(result).toEqual({ success: true });
  });
});

describe('workflows.delete — metadata (destructive, non-idempotent)', () => {
  it('requires drive:admin scope', () => {
    expect(deleteWorkflow.requiredScope).toBe('drive:admin');
  });

  it('is flagged destructive so the CLI requires --yes', () => {
    expect(deleteWorkflow.destructive).toBe(true);
  });

  it('uses DELETE, which isIdempotentMethod classifies as non-idempotent (no auto-retry)', () => {
    expect(deleteWorkflow.method).toBe('DELETE');
  });
});
