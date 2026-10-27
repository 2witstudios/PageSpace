import { describe, expect, it } from 'vitest';
import { buildRequest } from '../../transport/build-request.js';
import { parseResponse } from '../../transport/parse-response.js';
import { ResponseValidationError } from '../../errors.js';
import { execInWorkspace, listWorkspaces } from '../workspaces.js';

const config = { baseUrl: 'https://pagespace.ai' };

/** Shape verified against agentSessionDtoSchema (packages/lib/src/agent-workspaces/session-contract.ts) + the GET route's attached children. */
const workspaceFixture = {
  workspaceId: 'ws1abc',
  sessionId: 'ws1abc',
  driveId: 'd1abc',
  ownerId: 'u1abc',
  name: 'worker',
  envId: null,
  sandboxStatus: 'running',
  createdAt: '2026-01-01T00:00:00.000Z',
  lastActiveAt: null,
  endedAt: null,
  shells: [],
  conversations: [],
  rev: 0,
  nodes: [],
  targets: [],
};


describe('workspaces.list — request shape', () => {
  it('sends a bare GET with no filter', () => {
    const request = buildRequest(listWorkspaces, {}, config);
    expect(request.method).toBe('GET');
    expect(request.url).toBe('https://pagespace.ai/api/agent-workspaces');
    expect(request.body).toBeUndefined();
  });

  it('narrows by driveId through the query string', () => {
    const request = buildRequest(listWorkspaces, { driveId: 'd1abc' }, config);
    expect(request.url).toBe('https://pagespace.ai/api/agent-workspaces?driveId=d1abc');
  });
});

describe('workspaces.list — response contract', () => {
  it('parses the route body and keeps the extra fields it carries', () => {
    const body = { sessions: [workspaceFixture] };
    expect(parseResponse(listWorkspaces, 200, new Headers(), JSON.stringify(body))).toEqual(body);
  });

  it('rejects a body missing the sessions array', () => {
    expect(parseResponse(listWorkspaces, 200, new Headers(), '{}')).toBeInstanceOf(ResponseValidationError);
  });
});

describe('workspaces.exec — request shape', () => {
  it('interpolates :workspaceId and sends the rest as the JSON body', () => {
    const request = buildRequest(
      execInWorkspace,
      { workspaceId: 'ws1abc', command: 'ls -la', cwd: 'repo', timeoutMs: 5000 },
      config,
    );
    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://pagespace.ai/api/agent-workspaces/ws1abc/exec');
    expect(JSON.parse(String(request.body))).toEqual({ command: 'ls -la', cwd: 'repo', timeoutMs: 5000 });
  });

  it('rejects an empty command and unknown fields at the input schema', () => {
    expect(execInWorkspace.inputSchema.safeParse({ workspaceId: 'ws1abc', command: '' }).success).toBe(false);
    expect(execInWorkspace.inputSchema.safeParse({ workspaceId: 'ws1abc', command: 'ls', shell: true }).success).toBe(false);
  });

  it('outlasts the server-side 200s run ceiling', () => {
    expect(execInWorkspace.timeoutMsOverride).toBeGreaterThan(200_000);
  });
});

describe('workspaces.exec — response contract', () => {
  it('parses a non-zero exit as a normal result', () => {
    const body = { stdout: 'hi\n', stderr: '', exitCode: 3, truncated: false };
    expect(parseResponse(execInWorkspace, 200, new Headers(), JSON.stringify(body))).toEqual(body);
  });
});
