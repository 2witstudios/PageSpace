import { esc } from './_html';

export interface VttSegment {
  speaker: string;
  text: string;
  startTime: string;
}

const TIMESTAMP_LINE = /^\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}/;
const SPEAKER_PREFIX = /^([^:]+):\s*(.*)/;

export function parseVtt(vttText: string): VttSegment[] {
  const segments: VttSegment[] = [];
  const lines = vttText.split('\n');

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();

    if (TIMESTAMP_LINE.test(line)) {
      const startTime = line.split(' --> ')[0];
      const textLine = lines[i + 1]?.trim() ?? '';

      if (textLine) {
        const match = SPEAKER_PREFIX.exec(textLine);
        const speaker = match ? match[1].trim() : 'Unknown';
        const text = match ? match[2].trim() : textLine;
        segments.push({ speaker, text, startTime });
      }
    }

    i++;
  }

  return segments;
}

export function vttToHtml(segments: VttSegment[]): string {
  if (segments.length === 0) return '';

  const parts: string[] = [];
  let currentSpeaker = '';
  let currentLines: string[] = [];

  const flush = () => {
    if (currentLines.length > 0) {
      parts.push(
        `<p><strong>${esc(currentSpeaker)}</strong><br>${currentLines.map(esc).join(' ')}</p>`
      );
    }
  };

  for (const seg of segments) {
    if (seg.speaker !== currentSpeaker) {
      flush();
      currentSpeaker = seg.speaker;
      currentLines = [seg.text];
    } else {
      currentLines.push(seg.text);
    }
  }

  flush();
  return parts.join('\n');
}
