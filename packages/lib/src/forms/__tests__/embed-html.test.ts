import { describe, it, expect } from 'vitest';
import { spliceFormHtml } from '../embed-html';

describe('spliceFormHtml', () => {
  it('appends the marked block to empty content on a first-time create', () => {
    const result = spliceFormHtml({ content: '', html: '<form>A</form>', formTargetId: 'ft-1' });

    expect(result).toBe('<!-- pagespace:form:ft-1 start -->\n<form>A</form>\n<!-- pagespace:form:ft-1 end -->\n');
  });

  it('appends the marked block after existing content on a first-time create', () => {
    const result = spliceFormHtml({
      content: '<h1>Welcome</h1>',
      html: '<form>A</form>',
      formTargetId: 'ft-1',
    });

    expect(result).toBe(
      '<h1>Welcome</h1>\n\n<!-- pagespace:form:ft-1 start -->\n<form>A</form>\n<!-- pagespace:form:ft-1 end -->\n'
    );
  });

  it('replaces the old marker block in place when replacesFormTargetId is present in content', () => {
    const content =
      '<h1>Welcome</h1>\n\n<!-- pagespace:form:ft-old start -->\n<form>OLD</form>\n<!-- pagespace:form:ft-old end -->\n\n<footer>bye</footer>';

    const result = spliceFormHtml({
      content,
      html: '<form>NEW</form>',
      formTargetId: 'ft-new',
      replacesFormTargetId: 'ft-old',
    });

    expect(result).toBe(
      '<h1>Welcome</h1>\n\n<!-- pagespace:form:ft-new start -->\n<form>NEW</form>\n<!-- pagespace:form:ft-new end -->\n\n<footer>bye</footer>'
    );
    expect(result).not.toContain('ft-old');
    expect(result).not.toContain('OLD');
  });

  it('falls back to appending when the old marker block is not found (hand-edited away)', () => {
    const content = '<h1>Redesigned page, form markers long gone</h1>';

    const result = spliceFormHtml({
      content,
      html: '<form>NEW</form>',
      formTargetId: 'ft-new',
      replacesFormTargetId: 'ft-old',
    });

    expect(result).toBe(
      '<h1>Redesigned page, form markers long gone</h1>\n\n<!-- pagespace:form:ft-new start -->\n<form>NEW</form>\n<!-- pagespace:form:ft-new end -->\n'
    );
  });

  it('does not let a formTargetId with regex-special characters break the match', () => {
    const content =
      '<!-- pagespace:form:ft.old+1 start -->\n<form>OLD</form>\n<!-- pagespace:form:ft.old+1 end -->';

    const result = spliceFormHtml({
      content,
      html: '<form>NEW</form>',
      formTargetId: 'ft-new',
      replacesFormTargetId: 'ft.old+1',
    });

    expect(result).toBe('<!-- pagespace:form:ft-new start -->\n<form>NEW</form>\n<!-- pagespace:form:ft-new end -->');
  });
});
