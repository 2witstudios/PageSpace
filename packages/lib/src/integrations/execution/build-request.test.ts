/**
 * Pure Request Building Tests
 *
 * Tests for buildHttpRequest - a pure function that builds HTTP requests
 * from templates and input values.
 */

import { describe, it, expect } from 'vitest';
import { buildHttpRequest, interpolatePath, resolveValue, resolveBody } from './build-request';
import type { HttpExecutionConfig } from '../types';

describe('interpolatePath', () => {
  it('given path template with {param} placeholders, should interpolate values from input', () => {
    const template = '/repos/{owner}/{repo}/issues';
    const input = { owner: 'acme', repo: 'webapp' };

    const result = interpolatePath(template, input);

    expect(result).toBe('/repos/acme/webapp/issues');
  });

  it('given path with no placeholders, should return unchanged', () => {
    const template = '/user/repos';
    const input = {};

    const result = interpolatePath(template, input);

    expect(result).toBe('/user/repos');
  });

  it('given missing param value, should leave placeholder empty', () => {
    const template = '/repos/{owner}/{repo}';
    const input = { owner: 'acme' };

    const result = interpolatePath(template, input);

    expect(result).toBe('/repos/acme/');
  });

  it('given numeric param value, should convert to string', () => {
    const template = '/issues/{issueNumber}';
    const input = { issueNumber: 123 };

    const result = interpolatePath(template, input);

    expect(result).toBe('/issues/123');
  });
});

describe('resolveValue', () => {
  it('given string value, should return as-is', () => {
    expect(resolveValue('static-value', {})).toBe('static-value');
  });

  it('given $param reference, should resolve from input', () => {
    const ref = { $param: 'name' };
    const input = { name: 'John' };

    expect(resolveValue(ref, input)).toBe('John');
  });

  it('given $param with transform string, should convert to string', () => {
    const ref = { $param: 'count', transform: 'string' as const };
    const input = { count: 42 };

    expect(resolveValue(ref, input)).toBe('42');
  });

  it('given $param with transform number, should convert to number', () => {
    const ref = { $param: 'count', transform: 'number' as const };
    const input = { count: '42' };

    expect(resolveValue(ref, input)).toBe(42);
  });

  it('given $param with transform boolean, should convert to boolean', () => {
    const ref = { $param: 'active', transform: 'boolean' as const };
    const input = { active: 'true' };

    expect(resolveValue(ref, input)).toBe(true);
  });

  it('given missing param, should return undefined', () => {
    const ref = { $param: 'missing' };
    const input = {};

    expect(resolveValue(ref, input)).toBeUndefined();
  });
});

describe('resolveBody', () => {
  it('given body template with nested $param references, should deep-resolve all values', () => {
    const template = {
      user: {
        name: { $param: 'userName' },
        email: { $param: 'userEmail' },
      },
      settings: {
        notifications: { $param: 'enableNotifications' },
      },
    };
    const input = {
      userName: 'Alice',
      userEmail: 'alice@example.com',
      enableNotifications: true,
    };

    const result = resolveBody(template, input);

    expect(result).toEqual({
      user: {
        name: 'Alice',
        email: 'alice@example.com',
      },
      settings: {
        notifications: true,
      },
    });
  });

  it('given array in body template, should resolve each element', () => {
    const template = {
      tags: [{ $param: 'tag1' }, { $param: 'tag2' }, 'static-tag'],
    };
    const input = { tag1: 'bug', tag2: 'urgent' };

    const result = resolveBody(template, input);

    expect(result).toEqual({
      tags: ['bug', 'urgent', 'static-tag'],
    });
  });

  it('given static values, should preserve them', () => {
    const template = {
      type: 'issue',
      priority: 1,
      title: { $param: 'title' },
    };
    const input = { title: 'Bug report' };

    const result = resolveBody(template, input);

    expect(result).toEqual({
      type: 'issue',
      priority: 1,
      title: 'Bug report',
    });
  });
});

describe('buildHttpRequest', () => {
  it('given full config, should build complete request', () => {
    const config: HttpExecutionConfig = {
      method: 'POST',
      pathTemplate: '/repos/{owner}/{repo}/issues',
      queryParams: {
        format: 'json',
      },
      headers: {
        'Content-Type': 'application/json',
      },
      bodyTemplate: {
        title: { $param: 'title' },
        body: { $param: 'body' },
      },
      bodyEncoding: 'json',
    };
    const input = {
      owner: 'acme',
      repo: 'webapp',
      title: 'Bug report',
      body: 'Description here',
    };
    const baseUrl = 'https://api.github.com';

    const result = buildHttpRequest(config, input, baseUrl);

    expect(result.method).toBe('POST');
    expect(result.url).toBe('https://api.github.com/repos/acme/webapp/issues?format=json');
    expect(result.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(result.body).toBe('{"title":"Bug report","body":"Description here"}');
  });

  it('given body encoding json, should JSON.stringify the body', () => {
    const config: HttpExecutionConfig = {
      method: 'POST',
      pathTemplate: '/data',
      bodyTemplate: { key: 'value' },
      bodyEncoding: 'json',
    };

    const result = buildHttpRequest(config, {}, 'https://api.example.com');

    expect(result.body).toBe('{"key":"value"}');
  });

  it('given body encoding form, should URL-encode the body', () => {
    const config: HttpExecutionConfig = {
      method: 'POST',
      pathTemplate: '/form',
      bodyTemplate: {
        username: { $param: 'user' },
        password: { $param: 'pass' },
      },
      bodyEncoding: 'form',
    };
    const input = { user: 'admin', pass: 'secret123' };

    const result = buildHttpRequest(config, input, 'https://api.example.com');

    expect(result.body).toBe('username=admin&password=secret123');
  });

  it('given query params with $param references, should resolve from input', () => {
    const config: HttpExecutionConfig = {
      method: 'GET',
      pathTemplate: '/search',
      queryParams: {
        q: { $param: 'query' },
        limit: { $param: 'limit', transform: 'string' },
      },
    };
    const input = { query: 'test', limit: 10 };

    const result = buildHttpRequest(config, input, 'https://api.example.com');

    expect(result.url).toBe('https://api.example.com/search?q=test&limit=10');
  });

  it('given GET request, should not include body', () => {
    const config: HttpExecutionConfig = {
      method: 'GET',
      pathTemplate: '/items',
    };

    const result = buildHttpRequest(config, {}, 'https://api.example.com');

    expect(result.body).toBeUndefined();
  });

  it('given undefined query param value, should skip that param', () => {
    const config: HttpExecutionConfig = {
      method: 'GET',
      pathTemplate: '/items',
      queryParams: {
        filter: { $param: 'filter' },
        sort: 'name',
      },
    };
    const input = {}; // filter not provided

    const result = buildHttpRequest(config, input, 'https://api.example.com');

    expect(result.url).toBe('https://api.example.com/items?sort=name');
  });

  it('given base URL with trailing slash, should handle correctly', () => {
    const config: HttpExecutionConfig = {
      method: 'GET',
      pathTemplate: '/items',
    };

    const result = buildHttpRequest(config, {}, 'https://api.example.com/');

    expect(result.url).toBe('https://api.example.com/items');
  });

  it('given base URL with path segment, should preserve base path', () => {
    const config: HttpExecutionConfig = {
      method: 'POST',
      pathTemplate: '/mail/send',
    };

    const result = buildHttpRequest(config, {}, 'https://api.sendgrid.com/v3');

    expect(result.url).toBe('https://api.sendgrid.com/v3/mail/send');
  });

  it('given base URL with path and trailing slash, should handle correctly', () => {
    const config: HttpExecutionConfig = {
      method: 'GET',
      pathTemplate: '/users',
    };

    const result = buildHttpRequest(config, {}, 'https://api.example.com/v1/');

    expect(result.url).toBe('https://api.example.com/v1/users');
  });
});
