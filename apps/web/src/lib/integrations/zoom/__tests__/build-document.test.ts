import { describe, it, expect } from 'vitest';
import { buildDocumentHtml } from '../build-document';

const META = {
  topic: 'Q3 Planning',
  startTime: '2026-05-18T14:00:00Z',
  duration: 45,
  hostEmail: 'alice@example.com',
};

describe('buildDocumentHtml', () => {
  it('given any options, should always include a metadata block with topic, date, duration, and host', () => {
    const html = buildDocumentHtml(META, { summary: '', actionItems: [], transcriptHtml: '' });

    expect(html).toContain('Q3 Planning');
    expect(html).toContain('alice@example.com');
    expect(html).toContain('45');
  });

  it('given a non-empty summary, should include an <h2>Summary</h2> section', () => {
    const html = buildDocumentHtml(META, {
      summary: 'We decided to increase budget by 10%.',
      actionItems: [],
      transcriptHtml: '',
    });

    expect(html).toContain('<h2>Summary</h2>');
    expect(html).toContain('We decided to increase budget by 10%.');
  });

  it('given an empty summary, should not include a Summary section', () => {
    const html = buildDocumentHtml(META, { summary: '', actionItems: [], transcriptHtml: '' });

    expect(html).not.toContain('<h2>Summary</h2>');
  });

  it('given action items without assignees, should render a list with item text only', () => {
    const html = buildDocumentHtml(META, {
      summary: '',
      actionItems: [
        { text: 'Draft the proposal' },
        { text: 'Schedule follow-up' },
      ],
      transcriptHtml: '',
    });

    expect(html).toContain('<h2>Action Items</h2>');
    expect(html).toContain('Draft the proposal');
    expect(html).toContain('Schedule follow-up');
  });

  it('given action items with assignees, should append (assignee) to each item', () => {
    const html = buildDocumentHtml(META, {
      summary: '',
      actionItems: [
        { text: 'Draft the proposal', assignee: 'Alice' },
        { text: 'Review budget', assignee: 'Bob' },
      ],
      transcriptHtml: '',
    });

    expect(html).toContain('Draft the proposal');
    expect(html).toContain('(Alice)');
    expect(html).toContain('(Bob)');
  });

  it('given an empty actionItems array, should not include an Action Items section', () => {
    const html = buildDocumentHtml(META, { summary: '', actionItems: [], transcriptHtml: '' });

    expect(html).not.toContain('<h2>Action Items</h2>');
  });

  it('given a non-empty transcriptHtml, should include a <h2>Transcript</h2> section', () => {
    const html = buildDocumentHtml(META, {
      summary: '',
      actionItems: [],
      transcriptHtml: '<p><strong>Alice</strong><br>Hello.</p>',
    });

    expect(html).toContain('<h2>Transcript</h2>');
    expect(html).toContain('<strong>Alice</strong>');
  });

  it('given an empty transcriptHtml, should not include a Transcript section', () => {
    const html = buildDocumentHtml(META, { summary: '', actionItems: [], transcriptHtml: '' });

    expect(html).not.toContain('<h2>Transcript</h2>');
  });

  it('given all sections populated, should order: metadata → summary → action items → transcript', () => {
    const html = buildDocumentHtml(META, {
      summary: 'Key decisions made.',
      actionItems: [{ text: 'Follow up', assignee: 'Alice' }],
      transcriptHtml: '<p><strong>Alice</strong><br>Hello.</p>',
    });

    const summaryIdx = html.indexOf('<h2>Summary</h2>');
    const actionsIdx = html.indexOf('<h2>Action Items</h2>');
    const transcriptIdx = html.indexOf('<h2>Transcript</h2>');

    expect(summaryIdx).toBeLessThan(actionsIdx);
    expect(actionsIdx).toBeLessThan(transcriptIdx);
  });

  it('given meta fields containing HTML special characters, should escape them', () => {
    const html = buildDocumentHtml(
      { topic: '<script>alert(1)</script>', startTime: '2026-05-18T14:00:00Z', duration: 30, hostEmail: 'a&b@example.com' },
      { summary: '', actionItems: [], transcriptHtml: '' },
    );

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('a&amp;b@example.com');
  });

  it('given action item text and assignee containing HTML special characters, should escape them', () => {
    const html = buildDocumentHtml(META, {
      summary: '',
      actionItems: [{ text: '<b>task</b>', assignee: '<img src=x onerror=alert(1)>' }],
      transcriptHtml: '',
    });

    expect(html).not.toContain('<b>task</b>');
    expect(html).toContain('&lt;b&gt;task&lt;/b&gt;');
    expect(html).not.toContain('<img');
  });
});
