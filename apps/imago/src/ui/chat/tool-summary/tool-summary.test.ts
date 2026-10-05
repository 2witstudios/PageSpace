import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { DETAIL_LIMIT, toolLabel, toolSummary, type ToolPart } from './tool-summary';

const part = (overrides: Partial<ToolPart> & Pick<ToolPart, 'state'>): ToolPart =>
  ({ type: 'tool-read_page', toolCallId: 'call-1', input: { pageId: 'p1', title: 'Roadmap' }, ...overrides }) as ToolPart;

describe('toolLabel()', () => {
  test('sentence case', () => {
    assert({
      given: 'snake_case, kebab-case and camelCase tool names',
      should: 'read as sentence-case words',
      actual: ['read_page', 'web-search', 'listPages', 'mcp__github__get_issue'].map(toolLabel),
      expected: ['Read page', 'Web search', 'List pages', 'Mcp github get issue'],
    });
  });
});

describe('toolSummary()', () => {
  test('states', () => {
    assert({
      given: 'a call streaming its input, running, done, failed and denied',
      should: 'say running, running, done, failed and denied',
      actual: (['input-streaming', 'input-available', 'output-available', 'output-error', 'output-denied'] as const).map(
        (state) => toolSummary(part({ state, output: {}, errorText: 'boom' } as Partial<ToolPart> & Pick<ToolPart, 'state'>)).state,
      ),
      expected: ['running', 'running', 'done', 'failed', 'denied'],
    });
  });

  test('one line', () => {
    const summary = toolSummary(part({ state: 'output-available', output: { success: true } }));
    assert({
      given: 'a finished read_page call on the Roadmap',
      should: 'name the call and what it acted on, with its input and output for the expanded view',
      actual: [summary.id, summary.name, summary.target, summary.input, summary.output],
      expected: ['call-1', 'Read page', 'Roadmap', '{\n  "pageId": "p1",\n  "title": "Roadmap"\n}', '{\n  "success": true\n}'],
    });
  });

  test('targets', () => {
    const targets = [{ query: 'launch' }, { path: '/docs/a.md' }, { url: 'https://example.com' }, { pageId: 'p1' }, 'raw'].map(
      (input) => toolSummary(part({ state: 'input-available', input })).target,
    );
    assert({
      given: 'inputs with a query, a path, a url, only an id, and a bare string',
      should: 'name the first readable one and nothing for an id alone or a non-object',
      actual: targets,
      expected: ['launch', '/docs/a.md', 'https://example.com', null, null],
    });
  });

  test('failed', () => {
    const summary = toolSummary(part({ state: 'output-error', errorText: 'Page not found' }));
    assert({
      given: 'a call that failed',
      should: 'carry the error as its output',
      actual: summary.output,
      expected: 'Page not found',
    });
  });

  test('long detail', () => {
    const summary = toolSummary(part({ state: 'output-available', output: 'x'.repeat(DETAIL_LIMIT + 50) }));
    assert({
      given: 'an output longer than the detail limit',
      should: 'cut it at the limit with an ellipsis',
      actual: [summary.output?.length, summary.output?.endsWith('…')],
      expected: [DETAIL_LIMIT + 1, true],
    });
  });

  test('dynamic tools and no input yet', () => {
    const summary = toolSummary({ type: 'dynamic-tool', toolName: 'list_drives', toolCallId: 'call-9', state: 'input-streaming', input: undefined });
    assert({
      given: 'a dynamic tool whose input has not arrived',
      should: 'name it from its toolName and show no input',
      actual: [summary.name, summary.input, summary.output, summary.target],
      expected: ['List drives', null, null, null],
    });
  });
});
