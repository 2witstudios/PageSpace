// Enhanced mention types for the flexible mention system

export type MentionType = 'page' | 'user' | 'everyone' | 'role';

export interface BaseMention {
  id: string;
  label: string;
  type: MentionType;
}

export interface PageMentionData {
  pageType: 'DOCUMENT' | 'FOLDER' | 'AI_CHAT' | 'CHANNEL' | 'SHEET';
  driveId: string;
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

export interface EnhancedMention extends BaseMention {
  data: MentionData;
}

// Type-specific mention interfaces
export interface PageMention extends BaseMention {
  type: 'page';
  data: PageMentionData;
}

export interface UserMention extends BaseMention {
  type: 'user';
  data: UserMentionData;
}

export interface EveryoneMention extends BaseMention {
  type: 'everyone';
  data: EveryoneMentionData;
}

export interface RoleMention extends BaseMention {
  type: 'role';
  data: RoleMentionData;
}

// Union type for all specific mention types
export type TypedMention =
  | PageMention
  | UserMention
  | EveryoneMention
  | RoleMention;

// For search results and suggestions
export interface MentionSuggestion {
  id: string;
  label: string;
  type: MentionType;
  data: MentionData;
  description?: string; // Optional description for search results
}

