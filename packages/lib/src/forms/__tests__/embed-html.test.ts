import { describe, it, expect } from 'vitest';
import { embedWiredBlock, deleteFormBlock } from '../embed-html';

describe('embedWiredBlock', () => {
  it('replaces the original bare form text with the marker-wrapped wired block', () => {
    const content = '<h1>Welcome</h1>\n\n<form><input name="email"></form>\n\n<footer>bye</footer>';

    const result = embedWiredBlock({
      content,
      originalFormHtml: '<form><input name="email"></form>',
      formTargetId: 'ft-1',
      wiredFormHtml: '<form id="pagespace-form-ft-1"><input name="email"></form>\n<script>/* wired */</script>',
    });

    expect(result).toBe(
      '<h1>Welcome</h1>\n\n<!-- pagespace:form:ft-1 start -->\n<form id="pagespace-form-ft-1"><input name="email"></form>\n<script>/* wired */</script>\n<!-- pagespace:form:ft-1 end -->\n\n<footer>bye</footer>'
    );
  });

  it('returns null when the original form text is not found verbatim', () => {
    const result = embedWiredBlock({
      content: '<h1>Redesigned, form markup changed</h1>',
      originalFormHtml: '<form><input name="email"></form>',
      formTargetId: 'ft-1',
      wiredFormHtml: '<form id="pagespace-form-ft-1"></form>',
    });

    expect(result).toBeNull();
  });

  it('supports multiple independently wired forms on the same page', () => {
    const content = '<form><input name="a"></form>\n\n<form><input name="b"></form>';

    const afterFirst = embedWiredBlock({
      content,
      originalFormHtml: '<form><input name="a"></form>',
      formTargetId: 'ft-a',
      wiredFormHtml: '<form id="pagespace-form-ft-a"><input name="a"></form>',
    });
    expect(afterFirst).not.toBeNull();

    const afterSecond = embedWiredBlock({
      content: afterFirst as string,
      originalFormHtml: '<form><input name="b"></form>',
      formTargetId: 'ft-b',
      wiredFormHtml: '<form id="pagespace-form-ft-b"><input name="b"></form>',
    });

    expect(afterSecond).toContain('pagespace:form:ft-a');
    expect(afterSecond).toContain('pagespace:form:ft-b');
  });
});

describe('deleteFormBlock', () => {
  it('removes the marker-wrapped block entirely, leaving surrounding content intact', () => {
    const content =
      '<h1>Welcome</h1>\n\n<!-- pagespace:form:ft-1 start -->\n<form id="pagespace-form-ft-1"></form>\n<script>x</script>\n<!-- pagespace:form:ft-1 end -->\n\n<footer>bye</footer>';

    const result = deleteFormBlock({ content, formTargetId: 'ft-1' });

    expect(result).toBe('<h1>Welcome</h1>\n\n<footer>bye</footer>');
    expect(result).not.toContain('ft-1');
  });

  it('is a no-op when the markers are not found', () => {
    const content = '<h1>No forms here</h1>';
    expect(deleteFormBlock({ content, formTargetId: 'ft-missing' })).toBe(content);
  });

  it('only removes the targeted form when multiple are wired', () => {
    const content =
      '<!-- pagespace:form:ft-a start -->\n<form id="a"></form>\n<!-- pagespace:form:ft-a end -->\n\n<!-- pagespace:form:ft-b start -->\n<form id="b"></form>\n<!-- pagespace:form:ft-b end -->';

    const result = deleteFormBlock({ content, formTargetId: 'ft-a' });

    expect(result).not.toContain('ft-a');
    expect(result).toContain('ft-b');
  });

  it('does not let a formTargetId with regex-special characters break the match', () => {
    const content = '<!-- pagespace:form:ft.old+1 start -->\n<form></form>\n<!-- pagespace:form:ft.old+1 end -->';
    const result = deleteFormBlock({ content, formTargetId: 'ft.old+1' });
    expect(result).toBe('');
  });
});
