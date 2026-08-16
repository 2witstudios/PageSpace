import { describe, it, expect } from 'vitest';
import { rewriteLinks, type RewriteHosts } from '../lib/extract-marketing-content';

const HOSTS: RewriteHosts = {
  docs: 'https://docs.pagespace.ai',
  blog: 'https://blog.pagespace.ai',
  marketing: 'https://pagespace.ai',
};

describe('rewriteLinks', () => {
  describe('on the docs site', () => {
    it('shortens same-site docs links to the new root', () => {
      expect(rewriteLinks('See [CLI](/docs/features/cli).', 'docs', HOSTS)).toBe('See [CLI](/features/cli).');
    });

    it('maps the docs index to /', () => {
      expect(rewriteLinks('[Docs](/docs)', 'docs', HOSTS)).toBe('[Docs](/)');
    });

    it('preserves fragments', () => {
      expect(rewriteLinks('[Audit](/docs/security/zero-trust#audit-logging)', 'docs', HOSTS)).toBe(
        '[Audit](/security/zero-trust#audit-logging)',
      );
    });

    it('absolutizes links to the blog, which is now a different origin', () => {
      expect(rewriteLinks('[Post](/blog/ai-versioning-safety)', 'docs', HOSTS)).toBe(
        '[Post](https://blog.pagespace.ai/ai-versioning-safety)',
      );
    });

    it('absolutizes links to pages the marketing site still owns', () => {
      // Left as a bare `/pricing` this would resolve against docs.pagespace.ai
      // after the move and 404 — the exact failure this function exists for.
      expect(rewriteLinks('[Pricing](/pricing)', 'docs', HOSTS)).toBe('[Pricing](https://pagespace.ai/pricing)');
    });

    it('repairs the dead agent-workspaces nav link to the page that actually exists', () => {
      expect(rewriteLinks('[Sandbox](/docs/features/agent-workspaces)', 'docs', HOSTS)).toBe(
        '[Sandbox](/features/agent-sessions)',
      );
    });
  });

  describe('on the blog site', () => {
    it('shortens same-site blog links and absolutizes docs links', () => {
      const md = 'See [that post](/blog/your-workspace-is-the-context) and [the CLI docs](/docs/features/cli).';
      expect(rewriteLinks(md, 'blog', HOSTS)).toBe(
        'See [that post](/your-workspace-is-the-context) and [the CLI docs](https://docs.pagespace.ai/features/cli).',
      );
    });
  });

  it('leaves /api/files references alone for the publish pipeline to resolve', () => {
    // rewriteCanvasAssets (apps/web/src/lib/canvas/asset-pipeline.ts) turns
    // these into public CDN URLs at publish time. Absolutizing them here would
    // leave every blog image behind an authenticated route.
    const md = '![hero](/api/files/abc123/view)';
    expect(rewriteLinks(md, 'blog', HOSTS)).toBe(md);
    expect(rewriteLinks(md, 'docs', HOSTS)).toBe(md);
  });

  it('leaves absolute URLs and anchor-only links untouched', () => {
    const md = '[ext](https://example.com/docs/x) and [anchor](#section) and [rel](./sibling)';
    expect(rewriteLinks(md, 'docs', HOSTS)).toBe(md);
  });

  it('rewrites every occurrence, not just the first', () => {
    const md = '[a](/docs/a) [b](/docs/b) [c](/pricing)';
    expect(rewriteLinks(md, 'docs', HOSTS)).toBe('[a](/a) [b](/b) [c](https://pagespace.ai/pricing)');
  });

  it('does not mistake a path that merely starts with the prefix for a child route', () => {
    // `/docsomething` is not under `/docs`; treating it as one would produce
    // the mangled path `omething`.
    expect(rewriteLinks('[x](/docsomething)', 'docs', HOSTS)).toBe('[x](https://pagespace.ai/docsomething)');
    expect(rewriteLinks('[x](/blogroll)', 'blog', HOSTS)).toBe('[x](https://pagespace.ai/blogroll)');
  });
});
