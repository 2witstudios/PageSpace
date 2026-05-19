export interface ActionItem {
  text: string;
  assignee?: string;
}

interface MeetingMeta {
  topic: string;
  startTime: string;
  duration: number;
  hostEmail: string;
}

interface DocumentOptions {
  summary: string;
  actionItems: ActionItem[];
  transcriptHtml: string;
}

export function buildDocumentHtml(meta: MeetingMeta, opts: DocumentOptions): string {
  const date = new Date(meta.startTime).toLocaleString('en-US', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'UTC',
  });

  const parts: string[] = [];

  parts.push(
    `<h2>Meeting Details</h2>` +
    `<table>` +
    `<tr><td><strong>Topic</strong></td><td>${meta.topic}</td></tr>` +
    `<tr><td><strong>Date</strong></td><td>${date}</td></tr>` +
    `<tr><td><strong>Duration</strong></td><td>${meta.duration} minutes</td></tr>` +
    `<tr><td><strong>Host</strong></td><td>${meta.hostEmail}</td></tr>` +
    `</table>`
  );

  if (opts.summary) {
    parts.push(`<h2>Summary</h2><p>${opts.summary}</p>`);
  }

  if (opts.actionItems.length > 0) {
    const items = opts.actionItems
      .map((item) => {
        const assignee = item.assignee ? ` (${item.assignee})` : '';
        return `<li>${item.text}${assignee}</li>`;
      })
      .join('');
    parts.push(`<h2>Action Items</h2><ul>${items}</ul>`);
  }

  if (opts.transcriptHtml) {
    parts.push(`<h2>Transcript</h2>${opts.transcriptHtml}`);
  }

  return parts.join('\n');
}
