/**
 * Content resolution and the sanitizer allowlist.
 *
 * The sanitizer is the trust boundary between "an admin typed something" and "hundreds of
 * mail clients parse it", with no CSP to fall back on. So the tests below are adversarial
 * about what gets through, and specific about the resolution failures that must refuse a
 * send rather than guess at intent.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  extractCtaUrls,
  renderMarkdownToSafeHtml,
  resolveBroadcastContent,
  type BroadcastTemplateContent,
} from '../content';

const noTemplates = vi.fn(async () => null);

describe('renderMarkdownToSafeHtml — what it keeps', () => {
  it('given ordinary markdown, should render the tags a broadcast needs', () => {
    const html = renderMarkdownToSafeHtml(
      '# Title\n\nHello **world**, and *thanks*.\n\n- one\n- two\n\n> quoted\n\n`code`\n',
    );

    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<strong>world</strong>');
    expect(html).toContain('<em>thanks</em>');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('<code>code</code>');
  });

  it('given a link, should keep the href', () => {
    const html = renderMarkdownToSafeHtml('[docs](https://pagespace.ai/docs)');
    expect(html).toContain('href="https://pagespace.ai/docs"');
  });

  it('given a mailto link, should keep it — replying is a legitimate CTA', () => {
    expect(renderMarkdownToSafeHtml('[write](mailto:hi@pagespace.ai)')).toContain('mailto:hi@pagespace.ai');
  });
});

describe('renderMarkdownToSafeHtml — what it refuses', () => {
  it('given a script tag, should drop it AND its contents', () => {
    // Stripping the tag but keeping the text would ship "alert(1)" as visible prose.
    const html = renderMarkdownToSafeHtml('Hi\n\n<script>alert(1)</script>\n');
    expect(html).not.toContain('script');
    expect(html).not.toContain('alert(1)');
  });

  it('given a javascript: href, should drop the link target', () => {
    const html = renderMarkdownToSafeHtml('[click](javascript:alert(1))');
    expect(html).not.toContain('javascript:');
  });

  it('given an inline event handler, should drop it', () => {
    const html = renderMarkdownToSafeHtml('<a href="https://x.test" onclick="steal()">x</a>');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('steal');
  });

  it('given an iframe or form, should drop it', () => {
    // A form in an email is a phishing shape, and an iframe is not renderable in most
    // clients anyway.
    const html = renderMarkdownToSafeHtml('<iframe src="https://evil.test"></iframe><form><input/></form>');
    expect(html).not.toContain('iframe');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<input');
  });

  it('given author styling, should drop it — the shell owns the look', () => {
    // An author-set colour is how a broadcast ends up unreadable in dark mode.
    const html = renderMarkdownToSafeHtml('<p style="color:#fff" class="x">hi</p>');
    expect(html).not.toContain('style=');
    expect(html).not.toContain('class=');
    expect(html).toContain('hi');
  });

  it('given a style block, should drop it and its contents', () => {
    const html = renderMarkdownToSafeHtml('<style>body{display:none}</style>\n\nHello');
    expect(html).not.toContain('display:none');
    expect(html).toContain('Hello');
  });

  it('given an image, should drop it — hosting and tracking pixels are not the author\'s call', () => {
    expect(renderMarkdownToSafeHtml('![alt](https://x.test/a.png)')).not.toContain('<img');
  });

  it('given a relative link, should drop the href — an email has no base to resolve it', () => {
    const html = renderMarkdownToSafeHtml('[docs](/docs/features)');
    expect(html).not.toContain('href="/docs/features"');
  });

  it('should never return a Promise stringified into the body', () => {
    // marked's return type is string | Promise<string>; the async overload would ship
    // "[object Promise]" to the entire audience.
    const html = renderMarkdownToSafeHtml('hello');
    expect(typeof html).toBe('string');
    expect(html).not.toContain('Promise');
  });
});

describe('resolveBroadcastContent — compose mode', () => {
  it('given composed markdown, should use it', async () => {
    const resolved = await resolveBroadcastContent(
      { contentMode: 'compose', subject: 'Hi', bodyMarkdown: 'Body', templateId: null },
      noTemplates,
    );
    expect(resolved).toEqual({ subject: 'Hi', bodyMarkdown: 'Body' });
  });

  it('given an empty body, should refuse rather than mail a blank email', async () => {
    await expect(
      resolveBroadcastContent(
        { contentMode: 'compose', subject: 'Hi', bodyMarkdown: '   ', templateId: null },
        noTemplates,
      ),
    ).rejects.toThrow(/no body/);
  });

  it('given no subject, should refuse', async () => {
    await expect(
      resolveBroadcastContent(
        { contentMode: 'compose', subject: '  ', bodyMarkdown: 'Body', templateId: null },
        noTemplates,
      ),
    ).rejects.toThrow(/no subject/);
  });
});

describe('resolveBroadcastContent — template mode', () => {
  const template: BroadcastTemplateContent = {
    subject: 'Template subject',
    bodyMarkdown: 'Template body',
    isActive: true,
  };
  const load = async () => template;

  it('given a template, should use its body', async () => {
    const resolved = await resolveBroadcastContent(
      { contentMode: 'template', subject: '', bodyMarkdown: null, templateId: 't1' },
      load,
    );
    expect(resolved).toEqual({ subject: 'Template subject', bodyMarkdown: 'Template body' });
  });

  it('given the broadcast its own subject, should prefer it over the template\'s', async () => {
    // So an admin can reuse a body under a new subject without versioning the template.
    const resolved = await resolveBroadcastContent(
      { contentMode: 'template', subject: 'Override', bodyMarkdown: null, templateId: 't1' },
      load,
    );
    expect(resolved.subject).toBe('Override');
  });

  it('given no templateId, should refuse', async () => {
    await expect(
      resolveBroadcastContent(
        { contentMode: 'template', subject: 'Hi', bodyMarkdown: null, templateId: null },
        noTemplates,
      ),
    ).rejects.toThrow(/names no template/);
  });

  it('given a missing template, should refuse', async () => {
    await expect(
      resolveBroadcastContent(
        { contentMode: 'template', subject: 'Hi', bodyMarkdown: null, templateId: 'gone' },
        noTemplates,
      ),
    ).rejects.toThrow(/not found/);
  });

  it('given a retired template, should refuse — deactivating IS the stop signal', async () => {
    await expect(
      resolveBroadcastContent(
        { contentMode: 'template', subject: 'Hi', bodyMarkdown: null, templateId: 't1' },
        async () => ({ ...template, isActive: false }),
      ),
    ).rejects.toThrow(/not active/);
  });

  it('given a template with an empty body, should refuse', async () => {
    await expect(
      resolveBroadcastContent(
        { contentMode: 'template', subject: 'Hi', bodyMarkdown: null, templateId: 't1' },
        async () => ({ ...template, bodyMarkdown: '  ' }),
      ),
    ).rejects.toThrow(/empty body/);
  });

  it('should ignore any composed body left over from a mode switch', async () => {
    // The mode is the source of truth; a stale draft body must not leak into a
    // template send.
    const resolved = await resolveBroadcastContent(
      { contentMode: 'template', subject: '', bodyMarkdown: 'STALE DRAFT', templateId: 't1' },
      load,
    );
    expect(resolved.bodyMarkdown).toBe('Template body');
  });
});

describe('extractCtaUrls', () => {
  it('given absolute links, should return them for the reachability check', () => {
    const urls = extractCtaUrls('<a href="https://a.test/x">a</a><a href="http://b.test">b</a>');
    expect(urls).toEqual(['https://a.test/x', 'http://b.test']);
  });

  it('given the same link twice, should return it once — one page, one check', () => {
    expect(extractCtaUrls('<a href="https://a.test">a</a><a href="https://a.test">again</a>')).toEqual([
      'https://a.test',
    ]);
  });

  it('given a mailto link, should skip it — there is nothing to fetch', () => {
    expect(extractCtaUrls('<a href="mailto:hi@x.test">mail</a>')).toEqual([]);
  });

  it('given no links, should return nothing so the preflight skips the check entirely', () => {
    expect(extractCtaUrls('<p>no links here</p>')).toEqual([]);
  });
});