import { describe, expect, it } from 'vitest';
import { buildRequest } from '../../transport/build-request.js';
import { parseResponse } from '../../transport/parse-response.js';
import { ResponseValidationError } from '../../errors.js';
import { createCommand, deleteCommand, listCommands, updateCommand } from '../commands.js';

const config = { baseUrl: 'https://pagespace.ai' };

/** `CommandResponse` (`commands/command-route-helpers.ts`), Date fields ISO-serialized over JSON. */
const commandFixture = {
  id: 'c1abc',
  scope: 'drive' as const,
  driveId: 'd1abc',
  trigger: 'summarize-thread',
  description: 'Summarize the current channel thread.',
  entryPageId: 'p1abc',
  type: 'document' as const,
  enabled: true,
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
};

describe('commands.list — request shape', () => {
  it('builds a GET to /api/commands with no query params (route reads none — driveId filtering is gone)', () => {
    const request = buildRequest(listCommands, {}, config);
    expect(request.method).toBe('GET');
    expect(request.url).toBe('https://pagespace.ai/api/commands');
    expect(request.body).toBeUndefined();
  });

  it('takes no input fields at all', () => {
    const result = listCommands.inputSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});

describe('commands.list — response contract', () => {
  it('parses { commands } enriched with entryPageTitle/entryPageDriveId/entryPageAvailable/authorName (route truth: commands/route.ts GET)', () => {
    const listItem = {
      ...commandFixture,
      entryPageTitle: 'Summarize Thread',
      entryPageDriveId: 'd1abc',
      entryPageAvailable: true,
      authorName: 'Ada',
    };
    const result = parseResponse(listCommands, 200, new Headers(), JSON.stringify({ commands: [listItem] }));
    expect(result).toEqual({ commands: [listItem] });
  });

  it('parses an unavailable/suppressed entry page as nulled metadata', () => {
    const listItem = {
      ...commandFixture,
      entryPageTitle: null,
      entryPageDriveId: null,
      entryPageAvailable: false,
      authorName: null,
    };
    const result = parseResponse(listCommands, 200, new Headers(), JSON.stringify({ commands: [listItem] }));
    expect(result).toEqual({ commands: [listItem] });
  });

  it('parses an empty list', () => {
    const result = parseResponse(listCommands, 200, new Headers(), JSON.stringify({ commands: [] }));
    expect(result).toEqual({ commands: [] });
  });

  it('rejects a response that drifts from the contract', () => {
    const malformed = { commands: [{ ...commandFixture, enabled: 'yes' }] };
    const result = parseResponse(listCommands, 200, new Headers(), JSON.stringify(malformed));
    expect(result).toBeInstanceOf(ResponseValidationError);
  });
});

describe('commands.list — metadata', () => {
  it('requires only account scope (no drive-scoping input at all)', () => {
    expect(listCommands.requiredScope).toBe('account');
  });
});

describe('commands.create — request shape', () => {
  it('builds a POST with trigger/description/entryPageId in the body', () => {
    const request = buildRequest(
      createCommand,
      { trigger: 'summarize-thread', description: 'Summarize the current channel thread.', entryPageId: 'p1abc' },
      config,
    );
    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://pagespace.ai/api/commands');
    expect(JSON.parse(request.body ?? '{}')).toEqual({
      trigger: 'summarize-thread',
      description: 'Summarize the current channel thread.',
      entryPageId: 'p1abc',
    });
  });

  it('accepts an optional driveId for a drive-scoped command', () => {
    const request = buildRequest(
      createCommand,
      { trigger: 'summarize-thread', description: 'Summarize.', entryPageId: 'p1abc', driveId: 'd1abc' },
      config,
    );
    expect(JSON.parse(request.body ?? '{}')).toMatchObject({ driveId: 'd1abc' });
  });

  it('rejects a trigger with uppercase or underscores (Agent Skills name rules: lowercase alphanumeric + single hyphens)', () => {
    const result = createCommand.inputSchema.safeParse({
      trigger: 'Summarize_Thread',
      description: 'Summarize.',
      entryPageId: 'p1abc',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a trigger with consecutive or leading hyphens', () => {
    const result = createCommand.inputSchema.safeParse({
      trigger: '-summarize--thread',
      description: 'Summarize.',
      entryPageId: 'p1abc',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a trigger over 64 chars', () => {
    const result = createCommand.inputSchema.safeParse({
      trigger: 'a'.repeat(65),
      description: 'Summarize.',
      entryPageId: 'p1abc',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty description', () => {
    const result = createCommand.inputSchema.safeParse({ trigger: 'summarize-thread', description: '', entryPageId: 'p1abc' });
    expect(result.success).toBe(false);
  });

  it('rejects a description over 1024 chars', () => {
    const result = createCommand.inputSchema.safeParse({
      trigger: 'summarize-thread',
      description: 'x'.repeat(1025),
      entryPageId: 'p1abc',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unrecognized field (userId/scope must never be settable from create input)', () => {
    const result = createCommand.inputSchema.safeParse({
      trigger: 'summarize-thread',
      description: 'Summarize.',
      entryPageId: 'p1abc',
      userId: 'sneaky',
    });
    expect(result.success).toBe(false);
  });
});

describe('commands.create — response contract', () => {
  it('parses a 201 { command }', () => {
    const result = parseResponse(createCommand, 201, new Headers(), JSON.stringify({ command: commandFixture }));
    expect(result).toEqual({ command: commandFixture });
  });

  it('classifies a 409 (duplicate trigger in scope) as a typed error, not a schema drift', () => {
    const result = parseResponse(createCommand, 409, new Headers(), JSON.stringify({ error: "A command with trigger 'summarize-thread' already exists in this scope" }));
    expect(result).not.toBeInstanceOf(ResponseValidationError);
  });

  it('classifies a 403 (non-owner/admin creating a drive command) as PermissionDeniedError', () => {
    const result = parseResponse(createCommand, 403, new Headers(), JSON.stringify({ error: 'Only the drive owner or admins can manage drive commands' }));
    expect((result as { code: string }).code).toBe('PERMISSION_DENIED');
  });
});

describe('commands.create — metadata', () => {
  it('requires only account scope (drive-admin authority is enforced server-side only when driveId is supplied)', () => {
    expect(createCommand.requiredScope).toBe('account');
  });
});

describe('commands.update — request shape', () => {
  it('interpolates :commandId and sends only the provided fields', () => {
    const request = buildRequest(updateCommand, { commandId: 'c1abc', enabled: false }, config);
    expect(request.method).toBe('PATCH');
    expect(request.url).toBe('https://pagespace.ai/api/commands/c1abc');
    expect(JSON.parse(request.body ?? '{}')).toEqual({ enabled: false });
  });

  it('rejects driveId (the route 400s: command scope cannot be changed)', () => {
    const result = updateCommand.inputSchema.safeParse({ commandId: 'c1abc', driveId: 'd2abc' });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid trigger on update the same way create does', () => {
    const result = updateCommand.inputSchema.safeParse({ commandId: 'c1abc', trigger: 'Not Valid' });
    expect(result.success).toBe(false);
  });
});

describe('commands.update — response contract', () => {
  it('parses { command }', () => {
    const result = parseResponse(updateCommand, 200, new Headers(), JSON.stringify({ command: commandFixture }));
    expect(result).toEqual({ command: commandFixture });
  });

  it('classifies a 404 (command not found / not owned) as NotFoundError', () => {
    const result = parseResponse(updateCommand, 404, new Headers(), JSON.stringify({ error: 'Command not found' }));
    expect((result as { code: string }).code).toBe('NOT_FOUND');
  });
});

describe('commands.update — metadata', () => {
  it('requires only account scope', () => {
    expect(updateCommand.requiredScope).toBe('account');
  });
});

describe('commands.delete — request shape', () => {
  it('builds a DELETE to /api/commands/:commandId', () => {
    const request = buildRequest(deleteCommand, { commandId: 'c1abc' }, config);
    expect(request.method).toBe('DELETE');
    expect(request.url).toBe('https://pagespace.ai/api/commands/c1abc');
    expect(request.body).toBeUndefined();
  });
});

describe('commands.delete — response contract', () => {
  it('parses { success: true }', () => {
    const result = parseResponse(deleteCommand, 200, new Headers(), JSON.stringify({ success: true }));
    expect(result).toEqual({ success: true });
  });
});

describe('commands.delete — metadata (destructive, non-idempotent)', () => {
  it('requires only account scope', () => {
    expect(deleteCommand.requiredScope).toBe('account');
  });

  it('is flagged destructive so the CLI requires --yes', () => {
    expect(deleteCommand.destructive).toBe(true);
  });

  it('uses DELETE, which isIdempotentMethod classifies as non-idempotent (no auto-retry)', () => {
    expect(deleteCommand.method).toBe('DELETE');
  });
});
