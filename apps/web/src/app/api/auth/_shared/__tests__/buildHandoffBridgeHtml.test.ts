import { describe, it, expect } from 'vitest';
import { buildHandoffBridgeHtml } from '../buildHandoffBridgeHtml';

describe('buildHandoffBridgeHtml', () => {
  const baseParams = {
    deepLink: 'pagespace://auth-exchange?code=abc123&provider=google',
    title: "You're signed in",
    body: 'Return to the desktop app — you can close this window.',
  };

  it('embeds the deep link in a meta refresh tag', () => {
    const html = buildHandoffBridgeHtml(baseParams);
    expect(html).toContain('http-equiv="refresh"');
    // Ampersands inside attributes must be entity-encoded
    expect(html).toContain('content="0; url=pagespace://auth-exchange?code=abc123&amp;provider=google"');
  });

  it('embeds the deep link in the noscript anchor fallback', () => {
    const html = buildHandoffBridgeHtml(baseParams);
    expect(html).toContain('<noscript>');
    expect(html).toContain('href="pagespace://auth-exchange?code=abc123&amp;provider=google"');
  });

  it('renders the title and body text', () => {
    const html = buildHandoffBridgeHtml(baseParams);
    expect(html).toContain('You&#39;re signed in');
    expect(html).toContain('Return to the desktop app');
  });

  it('escapes HTML-significant characters in user-provided strings', () => {
    const html = buildHandoffBridgeHtml({
      deepLink: 'pagespace://auth?code=<script>alert(1)</script>',
      title: '<img src=x onerror=alert(1)>',
      body: 'A "quoted" & < > value',
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;img');
    expect(html).toContain('&quot;quoted&quot;');
  });

  it('contains no inline <script> tags', () => {
    const html = buildHandoffBridgeHtml(baseParams);
    expect(html).not.toMatch(/<script[\s>]/i);
  });

  it('declares a doctype and html lang', () => {
    const html = buildHandoffBridgeHtml(baseParams);
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toContain('<html lang="en">');
  });
});
