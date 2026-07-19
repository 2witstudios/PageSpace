// Enhanced mention types for the flexible mention system

export type MentionType = 'page' | 'user' | 'everyone' | 'role';

export interface PageMentionData {
  pageType: 'DOCUMENT' | 'FOLDER' | 'AI_CHAT' | 'CHANNEL' | 'SHEET' | 'CANVAS' | 'FILE' | 'TASK_LIST' | 'CODE' | 'MACHINE';
  driveId: string;
  /** Present for FILE pages; lets image-only pickers filter/preview without a second lookup. */
  mimeType?: string | null;
}

// User mentions don't need additional data
// The label (user name) is sufficient
export type UserMentionData = Record<string, never>;

export interface EveryoneMentionData {
  driveId: string;
}

export interface RoleMentionData {
  driveId: string;
  roleId: string;
  color?: string;
}

export type MentionData =
  | PageMentionData
  | UserMentionData
  | EveryoneMentionData
  | RoleMentionData;

// For search results and suggestions
export interface MentionSuggestion {
  id: string;
  label: string;
  type: MentionType;
  data: MentionData;
  description?: string; // Optional description for search results
}

