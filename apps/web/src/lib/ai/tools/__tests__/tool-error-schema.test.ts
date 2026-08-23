import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  MAX_PARAMETER_ERROR_CHARS,
  MAX_SCHEMA_CHARS,
  describeToolSchema,
  formatInvalidParametersError,
  formatUnknownToolError,
  suggestToolNames,
} from '../tool-error-schema';
import { buildPageSpaceTools } from '../../core/ai-tools';

describe('describeToolSchema', () => {
  it('given an ordinary schema, should inline it as JSON Schema', () => {
    const rendered = describeToolSchema('editFile',
      z.object({ oldString: z.string(), newString: z.string(), path: z.string().optional() })
    );
    const parsed = JSON.parse(rendered) as {
      properties: Record<string, unknown>;
      required: string[];
    };

    // The whole point: the key names the caller got wrong are readable off the
    // error, with no second call.
    expect(Object.keys(parsed.properties).sort()).toEqual(['newString', 'oldString', 'path']);
    expect(parsed.required.sort()).toEqual(['newString', 'oldString']);
  });

  it('given a schema with descriptions, should keep them', () => {
    const rendered = describeToolSchema('git_clone',
      z.object({ repo_url: z.string().describe('HTTPS clone URL') })
    );
    expect(rendered).toContain('HTTPS clone URL');
  });

  it('given a schema too large to inline, should summarise it within the cap', () => {
    // Big by nesting, which is what actually makes a real schema big: 60 keys,
    // each carrying a nested object and a long description.
    const nested = z.object({
      alpha: z.string().describe('x'.repeat(200)),
      beta: z.object({ gamma: z.string(), delta: z.number() }),
    });
    const huge = z.object(
      Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`field_${i}`, nested]))
    );

    const rendered = describeToolSchema('huge_tool', huge);

    expect(rendered.length).toBeLessThanOrEqual(MAX_SCHEMA_CHARS);
    // A summarised schema must never read as the complete one.
    expect(rendered).toContain('summarised');
    // The names still survive — they are what the error exists to deliver.
    expect(rendered).toContain('field_0');
  });

  it('given more parameters than the budget holds, should say how many were dropped', () => {
    const wide = z.object(
      Object.fromEntries(
        Array.from({ length: 400 }, (_, i) => [
          `parameter_number_${i}`,
          z.string().describe('y'.repeat(300)),
        ])
      )
    );

    const rendered = describeToolSchema('wide_tool', wide);

    expect(rendered.length).toBeLessThanOrEqual(MAX_SCHEMA_CHARS);
    expect(rendered).toMatch(/and \d+ more parameter\(s\) not shown/);
  });

  it('given a huge enum on one parameter, should not let that line crowd out the others', () => {
    // The per-line budget check alone would keep the cap — by dropping every
    // OTHER parameter to make room for one absurd line. The names are what the
    // outline exists to deliver, so the type is clipped instead.
    const wide = z.object({
      first: z.string(),
      mode: z.enum(
        Array.from({ length: 500 }, (_, i) => `option_number_${i}`) as [string, ...string[]]
      ),
      last: z.string(),
    });

    const rendered = describeToolSchema('wide_tool', wide);

    expect(rendered.length).toBeLessThanOrEqual(MAX_SCHEMA_CHARS);
    expect(rendered).toContain('first');
    expect(rendered).toContain('last');
    // Nothing is dropped: clipping the one absurd type is enough to fit all
    // three names, which is the whole point.
    expect(rendered).not.toMatch(/more parameter\(s\) not shown/);
    // No single line may be longer than the type cap plus its framing.
    const longest = Math.max(...rendered.split('\n').map((line) => line.length));
    expect(longest).toBeLessThan(400);
  });

  it('given something that is not a Zod schema, should say so rather than throw', () => {
    expect(describeToolSchema('broken_tool', undefined)).toContain('unavailable');
    expect(describeToolSchema('broken_tool', { notASchema: true })).toContain('unavailable');
  });

  it('given every real PageSpace tool schema, should render it WHOLE, not summarised', () => {
    const tools = buildPageSpaceTools({ codeExecutionEnabled: true });
    const names = Object.keys(tools);
    expect(names.length).toBeGreaterThan(0);

    // Asserting the RENDERED length against the cap would be vacuous —
    // `describeToolSchema` enforces that bound by construction, so the
    // predicate can never fire and a tool that outgrew the cap would slip
    // through green. The claim worth guarding is the other one: that no
    // shipping tool needs the degraded rendering at all. A summarised or
    // unavailable rendering is not JSON, so parsing is the check.
    const degraded = names.filter((name) => {
      const rendered = describeToolSchema(name, tools[name]?.inputSchema);
      try {
        JSON.parse(rendered);
        return false;
      } catch {
        return true;
      }
    });

    expect(degraded).toEqual([]);
  });

  it('given the largest real tool schema, should leave real headroom under the cap', () => {
    // The companion to the test above: it says nothing degrades, this says by
    // how much. If a schema grows past the cap, the test above turns red and
    // this one names the number to re-derive the cap from.
    const tools = buildPageSpaceTools({ codeExecutionEnabled: true });
    const largest = Math.max(
      ...Object.entries(tools).map(([name, tool]) => describeToolSchema(name, tool.inputSchema).length)
    );

    expect(largest).toBeLessThan(MAX_SCHEMA_CHARS);
  });
});

  it('given a degraded rendering, should still hand back a usable lookup', () => {
    // The prompt now tells the model a rejection carries the schema and that it
    // need not run a tool_search. A degraded rendering with no pointer leaves
    // it with neither, so it retries blind — the exact loop this PR removes.
    const unavailable = describeToolSchema('mystery_tool', { notASchema: true });
    expect(unavailable).toContain('tool_search("select:mystery_tool")');

    // And the summarised path names the real tool, not a placeholder: a model
    // that literally called tool_search("select:<tool>") would get nothing back
    // and burn the round trip anyway.
    const huge = z.object(
      Object.fromEntries(
        Array.from({ length: 200 }, (_, i) => [`field_${i}`, z.string().describe('z'.repeat(100))])
      )
    );
    const summarised = describeToolSchema('create_calendar_event', huge);
    expect(summarised).toContain('tool_search("select:create_calendar_event")');
    expect(summarised).not.toContain('<tool>');
  });

  it('given an absurd tool name, should not echo it back unbounded', () => {
    // The name is model-supplied and neither entry point caps it, so echoing it
    // whole would rebuild the unbounded payload by another door.
    const rendered = describeToolSchema('n'.repeat(50_000), { notASchema: true });
    expect(rendered.length).toBeLessThan(300);
  });

describe('formatInvalidParametersError', () => {
  it('given a rejected call, should carry both the offending keys and the schema', () => {
    const schema = z.object({ id: z.string() });
    const parsed = schema.safeParse({ pageId: 'p1' });
    expect(parsed.success).toBe(false);

    const message = formatInvalidParametersError(
      'trash_page',
      schema,
      parsed.success ? '' : parsed.error.message
    );

    expect(message).toContain('Invalid parameters for "trash_page"');
    // Asserted on the SCHEMA section specifically. The zod message quotes the
    // offending key too, so a test that merely searched the whole string would
    // still pass with the schema removed.
    const marker = 'Input schema for "trash_page": ';
    const schemaSection = message.slice(message.indexOf(marker) + marker.length);
    expect(JSON.parse(schemaSection)).toMatchObject({
      properties: { id: { type: 'string' } },
      required: ['id'],
    });
    // No pointer to a second call — the payload that call would return is here.
    expect(message).not.toContain('tool_search("select:trash_page")');
  });

  it('given a call that produced hundreds of validation issues, should still bound the whole error', () => {
    // The zod message is one entry per ISSUE, so its length is set by what the
    // CALLER sent, not by the tool. Bounding only the schema would move the
    // context blowout rather than remove it.
    const schema = z.object(
      Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`field_number_${i}`, z.string()]))
    );
    const parsed = schema.safeParse({});
    expect(parsed.success).toBe(false);
    // Guard the guard: this only tests the cap if the message actually exceeds it.
    expect(parsed.success === false && parsed.error.message.length).toBeGreaterThan(4_000);

    const message = formatInvalidParametersError(
      'wide_tool',
      schema,
      parsed.success ? '' : parsed.error.message
    );

    expect(message.length).toBeLessThanOrEqual(MAX_PARAMETER_ERROR_CHARS);
    expect(message).toContain('further validation issues omitted');
    // The schema still arrives — the cut falls on the issue list, not on it.
    expect(message).toContain('Input schema for "wide_tool"');
  });
});

  it('given an absurd tool name, should not echo it back unbounded from either formatter', () => {
    // `describeToolSchema` clips its own copy of the name; these two formatters
    // quote it again — twice, in the invalid-parameters case — so each needs
    // its own clip or the bound leaks through the message framing.
    const absurd = 'n'.repeat(50_000);

    const invalid = formatInvalidParametersError(absurd, z.object({ id: z.string() }), 'boom');
    expect(invalid.length).toBeLessThanOrEqual(MAX_PARAMETER_ERROR_CHARS);

    const unknown = formatUnknownToolError(absurd, ['read_page', 'bash']);
    expect(unknown.length).toBeLessThan(500);
  });

describe('suggestToolNames', () => {
  it('given a snake_case guess at a camelCase tool, should suggest the real name', () => {
    // The exact dead end in this codebase: sandbox file tools are camelCase
    // while everything else is snake_case, and there is no mapping layer.
    expect(suggestToolNames('read_file', ['readFile', 'writeFile', 'trash_page'])).toEqual([
      'readFile',
    ]);
  });

  it('should rank the case/separator match above a closer-spelled other tool', () => {
    // `read_files` is one edit away and `readFile` is two, so edit distance
    // alone picks the wrong one. Collapsing case and separators is what makes
    // the camelCase tool the SAME name rather than a nearby one.
    expect(suggestToolNames('read_file', ['read_files', 'readFile'])[0]).toBe('readFile');
  });

  it('given a near-miss spelling, should suggest by edit distance', () => {
    expect(suggestToolNames('git_logs', ['git_log', 'git_status', 'bash'])).toContain('git_log');
  });

  it('given nothing close, should suggest nothing', () => {
    expect(suggestToolNames('delete_everything', ['read_page', 'bash'])).toEqual([]);
  });

  it('should offer at most three names', () => {
    const candidates = Array.from({ length: 20 }, (_, i) => `list_thing_${i}`);
    expect(suggestToolNames('list_thing', candidates).length).toBeLessThanOrEqual(3);
  });

  it('given a name past the length bound, should refuse to search at all', () => {
    // Levenshtein is O(n*m) and the name is model-controlled — neither
    // `execute_tool` (`tool_name: z.string()`) nor the voice bridge
    // (`name: z.string().min(1)`) caps it. Unbounded, a 200k-character name
    // against ~200 candidates measured at 31 SECONDS of synchronous CPU, which
    // blocks the Node event loop for the whole web tier, not just that request.
    //
    // Asserted deterministically rather than on the clock: the candidate is an
    // exact normalized twin of the over-long name, so WITHOUT the bound it
    // would be returned instantly as a rank-0 match. Getting nothing back is
    // therefore proof the bound was applied, and it fails fast — a timing
    // assertion here would fail by HANGING, since a synchronous Levenshtein
    // cannot be interrupted by a test timeout.
    const overLong = 'q'.repeat(200);
    expect(overLong.length).toBeGreaterThan(128);

    expect(suggestToolNames(overLong, [overLong.toUpperCase(), 'bash'])).toEqual([]);
  });

  it('given a name of legitimate length, should still search normally', () => {
    // The bound must not be so tight that it turns away real names: 64 is the
    // ceiling `mcp-tool-converter` enforces, and it has to keep working.
    const realistic = 'a'.repeat(60);
    expect(suggestToolNames(realistic, [realistic.toUpperCase(), 'bash'])).toEqual([
      realistic.toUpperCase(),
    ]);
  });
});

describe('formatUnknownToolError', () => {
  it('given a near miss, should name it', () => {
    const message = formatUnknownToolError('read_file', ['readFile', 'bash']);
    expect(message).toContain('Unknown tool "read_file"');
    expect(message).toContain('Did you mean: readFile');
  });

  it('given no near miss, should fall back to tool_search', () => {
    const message = formatUnknownToolError('delete_everything', ['read_page']);
    expect(message).toContain('tool_search');
    expect(message).not.toContain('Did you mean');
  });
});
