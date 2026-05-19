import { describe, it, expect } from 'vitest';
import { parseVtt, vttToHtml } from '../parse-vtt';

const MULTI_SPEAKER_VTT = `WEBVTT

1
00:00:01.000 --> 00:00:05.000
Alice: Hello everyone, welcome to the meeting.

2
00:00:05.500 --> 00:00:10.000
Bob: Thanks for having us, Alice.

3
00:00:10.500 --> 00:00:15.000
Alice: Let's get started with the agenda.

4
00:00:15.500 --> 00:00:20.000
Alice: First item is the budget review.
`;

const NO_SPEAKER_VTT = `WEBVTT

1
00:00:01.000 --> 00:00:05.000
Hello, this has no speaker label.

2
00:00:05.500 --> 00:00:10.000
Another line with no speaker.
`;

const MIXED_VTT = `WEBVTT

1
00:00:01.000 --> 00:00:05.000
Alice: Hello.

2
00:00:05.500 --> 00:00:10.000
No speaker here.
`;

describe('parseVtt', () => {
  it('given a multi-speaker VTT, should return segments with correct speaker and text', () => {
    const segments = parseVtt(MULTI_SPEAKER_VTT);

    expect(segments).toHaveLength(4);
    expect(segments[0]).toMatchObject({ speaker: 'Alice', text: 'Hello everyone, welcome to the meeting.', startTime: '00:00:01.000' });
    expect(segments[1]).toMatchObject({ speaker: 'Bob', text: "Thanks for having us, Alice." });
    expect(segments[2]).toMatchObject({ speaker: 'Alice', text: "Let's get started with the agenda." });
    expect(segments[3]).toMatchObject({ speaker: 'Alice', text: 'First item is the budget review.' });
  });

  it('given segments with no speaker label, should use "Unknown"', () => {
    const segments = parseVtt(NO_SPEAKER_VTT);

    expect(segments[0]).toMatchObject({ speaker: 'Unknown', text: 'Hello, this has no speaker label.' });
    expect(segments[1]).toMatchObject({ speaker: 'Unknown', text: 'Another line with no speaker.' });
  });

  it('given an empty string, should return an empty array', () => {
    expect(parseVtt('')).toEqual([]);
  });

  it('given a VTT with only the header line, should return an empty array', () => {
    expect(parseVtt('WEBVTT\n')).toEqual([]);
  });

  it('given mixed speaker and no-speaker segments, should handle both', () => {
    const segments = parseVtt(MIXED_VTT);

    expect(segments[0]).toMatchObject({ speaker: 'Alice' });
    expect(segments[1]).toMatchObject({ speaker: 'Unknown' });
  });
});

describe('vttToHtml', () => {
  it('given segments from different speakers, should produce separate paragraphs', () => {
    const segments = parseVtt(MULTI_SPEAKER_VTT);
    const html = vttToHtml(segments);

    expect(html).toContain('<strong>Alice</strong>');
    expect(html).toContain('<strong>Bob</strong>');
  });

  it('given consecutive segments from the same speaker, should group them into one paragraph', () => {
    const segments = parseVtt(MULTI_SPEAKER_VTT);
    const html = vttToHtml(segments);

    // Alice appears in segments 1, 3, 4 — 3 and 4 are consecutive so should be one <p>
    const aliceBlocks = html.match(/<p><strong>Alice<\/strong>/g);
    expect(aliceBlocks).toHaveLength(2); // block 1 (seg 1) and block 2 (segs 3+4)
  });

  it('given an empty segments array, should return an empty string', () => {
    expect(vttToHtml([])).toBe('');
  });

  it('given an Unknown speaker, should still render a paragraph with "Unknown"', () => {
    const segments = parseVtt(NO_SPEAKER_VTT);
    const html = vttToHtml(segments);

    expect(html).toContain('<strong>Unknown</strong>');
  });

  it('given segments with HTML special characters in speaker or text, should escape them', () => {
    const segments = [
      { speaker: '<script>alert(1)</script>', text: 'A&B said <hello>', startTime: '00:00:01.000' },
    ];
    const html = vttToHtml(segments);

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('A&amp;B said &lt;hello&gt;');
  });
});
