import { describe, it, expect, afterAll } from 'vitest';
import { collectConstructs, createDomWorkspace, droppedConstructs } from '../constructs';

const workspace = createDomWorkspace();
afterAll(() => workspace.close());
const scan = (html: string) => collectConstructs(workspace.parse(html));

describe('collectConstructs', () => {
  it('collects every element tag name in the document', () => {
    const constructs = scan('<p>a</p><figure><img src="x.png"></figure>');
    expect([...constructs.elements].sort()).toEqual(['figure', 'img', 'p']);
  });

  it('collects inline style properties as style: keys, per element', () => {
    const constructs = scan('<p style="text-align: center; color: red">a</p>');
    expect([...(constructs.attributesByElement.get('p') ?? [])].sort()).toEqual([
      'style:color',
      'style:text-align',
    ]);
  });

  it('keeps the value of data-type, because taskList is a value not an attribute', () => {
    const constructs = scan('<ul data-type="taskList"><li data-checked="true">a</li></ul>');
    expect(constructs.attributesByElement.get('ul')).toContain('attr:data-type=taskList');
    expect(constructs.attributesByElement.get('li')).toContain('attr:data-checked');
  });

  it('normalises style property names, so one construct is not counted as three', () => {
    const constructs = scan('<p style="TEXT-ALIGN: center; ;  color:red;">a</p>');
    expect([...(constructs.attributesByElement.get('p') ?? [])].sort()).toEqual([
      'style:color',
      'style:text-align',
    ]);
  });

  it('records no attribute keys for an element that carries none', () => {
    const constructs = scan('<p>a</p>');
    expect(constructs.attributesByElement.has('p')).toBe(false);
  });

  it('returns nothing for empty content', () => {
    const constructs = scan('');
    expect(constructs.elements.size).toBe(0);
    expect(constructs.attributesByElement.size).toBe(0);
  });


});

describe('droppedConstructs', () => {
  const dropped = (source: string, output: string) =>
    droppedConstructs(scan(source), scan(output));

  it('reports an element present in the source and absent from the round trip', () => {
    expect(dropped('<p>a</p><img src="x.png">', '<p>a</p>')).toEqual(['<img>']);
  });

  it('reports an attribute dropped from an element that survived', () => {
    expect(dropped('<p style="text-align:center">a</p>', '<p>a</p>')).toEqual(['style:text-align']);
  });

  it('does not report attributes of an element that was itself dropped', () => {
    // <img> already tells the whole story; src/alt rows would trip the reader
    // into thinking three things were lost.
    expect(dropped('<img src="x.png" alt="y">', '')).toEqual(['<img>']);
  });

  it('aggregates one attribute key across the elements that carry it', () => {
    expect(
      dropped('<p style="text-align:center">a</p><h1 style="text-align:right">b</h1>', '<p>a</p><h1>b</h1>'),
    ).toEqual(['style:text-align']);
  });

  it('reports nothing when the round trip preserved everything', () => {
    expect(dropped('<p><strong>a</strong></p>', '<p><strong>a</strong></p>')).toEqual([]);
  });

  it('sorts its output so a report is stable between runs', () => {
    const result = dropped('<mark>a</mark><figure>b</figure><sup>c</sup>', '<p>abc</p>');
    expect(result).toEqual(['<figure>', '<mark>', '<sup>']);
  });
});
