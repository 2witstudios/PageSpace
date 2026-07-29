import { describe, it, expect, afterEach } from 'vitest';
import { resolveSelfBaseUrl } from '../session-tools-runtime';

/**
 * The internal worker-dispatch hop forwards the CALLER's own cookie and CSRF
 * token, so where it points is a security boundary, not just a convenience.
 * Resolving it from request routing headers was wrong twice over: a plain-HTTP
 * deployment has `host` but no `x-forwarded-proto`, so a header-first resolver
 * built `https://localhost:3000` and every dispatch failed before reaching the
 * chat pipeline; and a forged `x-forwarded-host` could steer those forwarded
 * credentials at an attacker-chosen origin.
 */
describe('resolveSelfBaseUrl', () => {
  const saved = { web: process.env.WEB_APP_URL, pub: process.env.NEXT_PUBLIC_APP_URL };

  afterEach(() => {
    process.env.WEB_APP_URL = saved.web;
    process.env.NEXT_PUBLIC_APP_URL = saved.pub;
    if (saved.web === undefined) delete process.env.WEB_APP_URL;
    if (saved.pub === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  });

  it('given WEB_APP_URL, should use it verbatim', () => {
    process.env.WEB_APP_URL = 'https://app.example.com';
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(resolveSelfBaseUrl()).toBe('https://app.example.com');
  });

  it('given a plain-HTTP configured origin, should preserve the scheme rather than forcing https', () => {
    // The documented local deployment. A header-derived resolver defaulted the
    // scheme to https here and broke every dispatch.
    process.env.WEB_APP_URL = 'http://localhost:3000';
    expect(resolveSelfBaseUrl()).toBe('http://localhost:3000');
  });

  it('given a trailing slash, should normalize it away so paths do not double up', () => {
    process.env.WEB_APP_URL = 'https://app.example.com/';
    expect(resolveSelfBaseUrl()).toBe('https://app.example.com');
  });

  it('given only NEXT_PUBLIC_APP_URL, should fall back to it', () => {
    delete process.env.WEB_APP_URL;
    process.env.NEXT_PUBLIC_APP_URL = 'https://public.example.com';
    expect(resolveSelfBaseUrl()).toBe('https://public.example.com');
  });

  it('given an empty WEB_APP_URL, should fall through rather than resolve to an empty origin', () => {
    process.env.WEB_APP_URL = '';
    process.env.NEXT_PUBLIC_APP_URL = 'https://public.example.com';
    expect(resolveSelfBaseUrl()).toBe('https://public.example.com');
  });

  it('given nothing configured, should return null so the dispatch reports a config error', () => {
    delete process.env.WEB_APP_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(resolveSelfBaseUrl()).toBeNull();
  });

  it('given a relative or malformed value, should return null rather than build a same-process path', () => {
    process.env.WEB_APP_URL = '/api';
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(resolveSelfBaseUrl()).toBeNull();
  });
});
