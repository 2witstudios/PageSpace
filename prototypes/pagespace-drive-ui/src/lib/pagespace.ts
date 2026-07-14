import { PageSpaceClient, StaticTokenProvider, isPageSpaceError, type PageSpaceError } from "@pagespace/sdk";

export function buildClient(apiUrl: string, token: string): PageSpaceClient {
  return new PageSpaceClient({ baseUrl: apiUrl, auth: new StaticTokenProvider(token) });
}

export function describeError(error: unknown): string {
  if (isPageSpaceError(error)) {
    const e = error as PageSpaceError;
    return `${e.code}: ${e.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

export type PageType = "FOLDER" | "DOCUMENT" | "CHANNEL" | "AI_CHAT" | "CANVAS" | "FILE" | "SHEET" | "TASK_LIST" | "CODE" | "TERMINAL";

// Page types whose content is a plain text/line body the SDK's read/replaceLines
// operations can round-trip through a textarea. FOLDER gets its own
// children-browser view instead; CHANNEL/AI_CHAT get a transcript view;
// TASK_LIST gets a checklist view; FILE gets a metadata card; SHEET/TERMINAL
// fall back to a generic metadata card.
export const TEXT_EDITABLE_TYPES: readonly PageType[] = ["DOCUMENT", "CANVAS", "CODE"];

const TYPE_ICONS: Record<PageType, string> = {
  FOLDER: "📁",
  DOCUMENT: "📄",
  CHANNEL: "💬",
  AI_CHAT: "🤖",
  CANVAS: "🎨",
  FILE: "📎",
  SHEET: "📊",
  TASK_LIST: "✅",
  CODE: "⌨️",
  TERMINAL: "🖥️",
};

export function iconForType(type: PageType): string {
  return TYPE_ICONS[type] ?? "•";
}

export type DriveRow = Awaited<ReturnType<PageSpaceClient["drives"]["list"]>>[number];
export type PageListResult = Awaited<ReturnType<PageSpaceClient["pages"]["list"]>>;
export type PageRow = PageListResult["pages"][number];
export type PageDetails = Awaited<ReturnType<PageSpaceClient["pages"]["details"]>>;
export type PageReadResult = Awaited<ReturnType<PageSpaceClient["pages"]["read"]>>;

export interface TrashedPage {
  id: string;
  title: string | null;
  type: PageType;
  isTrashed: boolean;
  trashedAt: string | null;
  children: TrashedPage[];
}

// pages.read's TASK_LIST branch — narrowed manually (see ContentPanel) since
// the SDK types pages.read as a 4-way discriminated union.
export interface TaskListReadResult {
  totalLines: number;
  tasks: Array<{
    id: string;
    title: string;
    status: string;
    priority: "low" | "medium" | "high";
    dueDate: string | null;
    assignee: { id: string; name: string | null; image: string | null } | null;
    assigneeAgent: { id: string; title: string | null; type: string } | null;
    subTaskCount: number;
    subTaskCompletedCount: number;
  }>;
  availableStatuses: Array<{ slug: string; label: string; group: string; position: number; color?: string | null }>;
  progress: { total: number; percentage: number; byGroup: Record<string, number>; bySlug: Record<string, number> };
}

// pages.read's FILE branch — same narrowing rationale as TaskListReadResult.
export interface FileReadResult {
  status: "pending" | "processing" | "failed" | "visual";
  error?: string;
  suggestion?: string;
  processingError?: string | null;
  message?: string;
  fileMetadata?: {
    mimeType: string | null;
    fileSize: number | null;
    originalFileName: string | null;
    processingStatus: string | null;
  };
}

// Unified shape for the transcript view — pages.details' messages (from
// reading a page) and client.channels.send's response (from posting one) use
// different wire schemas (the latter has no `email`), so both get mapped into
// this common shape rather than widening ChannelView to know about either.
export interface ChatMessage {
  id: string;
  content: string;
  createdAt: string;
  user: { name: string | null; email?: string } | null;
}

export function toChatMessage(message: PageDetails["messages"][number]): ChatMessage {
  return {
    id: message.id,
    content: message.content,
    createdAt: message.createdAt,
    user: message.user ? { name: message.user.name, email: message.user.email } : null,
  };
}

// pages.details' `messages` field is not populated for CHANNEL pages
// (verified against a real drive — stays [] right after sending a message
// through this same session), and the SDK exposes no structured
// "list channel messages" operation. pages.read's CHANNEL branch is the only
// source of history, but it flattens each message into one text line
// ("[user] Name (timestamp): content") rather than structured JSON — this
// parses that line format back into ChatMessage so the transcript can
// actually render on load instead of staying permanently empty.
const CHANNEL_LINE_PATTERN = /^\[(\w+)\] (.*?) \(([^)]+)\): ([\s\S]*)$/;

export function parseChannelTranscript(numberedLines: string[]): ChatMessage[] {
  return numberedLines
    .map((line, i) => {
      const withoutLineNumber = line.replace(/^\s*\d+\s*\|\s?/, "");
      const match = CHANNEL_LINE_PATTERN.exec(withoutLineNumber);
      if (!match) {
        return { id: `history-${i}`, content: withoutLineNumber, createdAt: new Date(0).toISOString(), user: null };
      }
      const [, , name, timestamp, content] = match;
      return { id: `history-${i}`, content, createdAt: timestamp, user: { name } };
    })
    .filter((m) => m.content.trim().length > 0);
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

export function preview(value: unknown): string {
  const json = JSON.stringify(value, null, 2);
  if (!json) return String(value);
  return json.length > 2000 ? json.slice(0, 2000) + "\n… (truncated)" : json;
}
