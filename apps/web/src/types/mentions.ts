// Enhanced mention types for the flexible mention system

export type MentionType = 'page' | 'user';

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

export type MentionData = 
  | PageMentionData 
  | UserMentionData;

// Type-specific mention interfaces
export interface PageMention extends BaseMention {
  type: 'page';
  data: PageMentionData;
}

export interface UserMention extends BaseMention {
  type: 'user';
  data: UserMentionData;
}

// For search results and suggestions
export interface MentionSuggestion {
  id: string;
  label: string;
  type: MentionType;
  data: MentionData;
  description?: string; // Optional description for search results
}

