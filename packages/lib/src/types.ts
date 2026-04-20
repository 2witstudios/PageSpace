import { PageType, PermissionAction } from './utils/enums';

// JSON-compatible value types for structured data (logging, metadata, etc.)
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

// Presence types for real-time "who is viewing this page" indicators
export interface PresenceViewer {
  userId: string;
  socketId: string;
  name: string;
  avatarUrl: string | null;
}

export interface PresencePageViewersPayload {
  pageId: string;
  viewers: PresenceViewer[];
}

export type ProcessingStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'visual';
export type ExtractionMethod = 'text' | 'ocr' | 'hybrid' | 'visual' | 'none';

export interface ExtractionMetadata {
  pageCount?: number;
  wordCount?: number;
  characterCount?: number;
  processingTimeMs?: number;
  extractionMethod?: ExtractionMethod;
  scribeVersion?: string;
  languages?: string[];
  confidence?: number;
}

export interface ExtractionResult {
  success: boolean;
  content: string;
  processingStatus: ProcessingStatus;
  extractionMethod?: ExtractionMethod;
  metadata?: ExtractionMetadata;
  error?: string;
  contentHash?: string;
}

export interface Page {
  id: string;
  title: string;
  type: PageType;
  content: string | null;
  position: number;
  isTrashed: boolean;
  createdAt: string; // ISO8601 date string from API
  updatedAt: string; // ISO8601 date string from API
  revision?: number;
  stateHash?: string | null;
  trashedAt: string | null; // ISO8601 date string from API
  driveId: string;
  parentId: string | null;
  originalParentId: string | null;
  isOwned?: boolean;
  accessLevel?: PermissionAction | null;
  // File-specific fields
  fileSize?: number;
  mimeType?: string;
  originalFileName?: string;
  filePath?: string;
  fileMetadata?: Record<string, JsonValue>;
  // Processing status fields
  processingStatus?: ProcessingStatus;
  processingError?: string;
  processedAt?: string; // ISO8601 date string from API
  extractionMethod?: ExtractionMethod;
  extractionMetadata?: ExtractionMetadata;
  contentHash?: string;
}

export interface Drive {
  id: string;
  name: string;
  slug: string;
  ownerId: string;
  isTrashed: boolean;
  trashedAt: string | null; // ISO8601 date string from API
  createdAt: string; // ISO8601 date string from API
  updatedAt: string; // ISO8601 date string from API
  isOwned: boolean;
  role?: 'OWNER' | 'ADMIN' | 'MEMBER';
  lastAccessedAt?: string | null; // ISO8601 date string from API
}

// Inbox types for unified DM/Channel inbox
export interface InboxItem {
  id: string;
  type: 'dm' | 'channel';
  name: string;
  avatarUrl: string | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  lastMessageSender: string | null;
  unreadCount: number;
  driveId?: string;
  driveName?: string;
}

export interface InboxResponse {
  items: InboxItem[];
  pagination: {
    hasMore: boolean;
    nextCursor: string | null;
  };
}

// =============================================================================
// "One-fetch on load" payload contracts
//
// These types define the server→client payload shapes that future Server
// Components will hand to the client store. They are pure data contracts —
// JSON-serializable, no methods, no class instances. Date fields are ISO8601
// strings so the payload survives the SSR/RSC boundary unchanged.
//
// The server-side fetchers `loadAppShell` and `loadPagePayload` produce values
// of these shapes; the future ECS hydration step consumes them.
// =============================================================================

export interface AppShellUser {
  id: string;
  name: string;
  email: string;
  image: string | null;
  role: 'user' | 'admin';
  subscriptionTier: string;
  timezone: string | null;
  currentAiProvider: string;
  currentAiModel: string;
}

export interface DriveSummary {
  id: string;
  name: string;
  slug: string;
  ownerId: string;
  drivePrompt: string | null;
  isOwned: boolean;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  isTrashed: boolean;
  createdAt: string;
  updatedAt: string;
  trashedAt: string | null;
  lastAccessedAt: string | null;
}

export interface DriveMemberSummary {
  id: string;
  driveId: string;
  userId: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  invitedAt: string;
  acceptedAt: string | null;
}

export type ConnectionStatus = 'PENDING' | 'ACCEPTED' | 'BLOCKED';

export interface ConnectionSummary {
  id: string;
  /** The OTHER user in the relationship — NOT the caller. */
  peerUserId: string;
  status: ConnectionStatus;
  /** True when the caller initiated the request, false when the peer did. */
  initiatedByCaller: boolean;
  requestedAt: string;
  acceptedAt: string | null;
}

/**
 * Flat page-tree node carried in the app-shell payload. The client builds a
 * nested tree via the existing `buildTree` helper from `content/tree-utils`.
 * Distinct from the generic `TreeNode<T>` exported there to avoid a name clash.
 */
export interface PageTreeNode {
  id: string;
  title: string;
  type: PageType;
  parentId: string | null;
  position: number;
}

/**
 * A single entry in a page breadcrumb. `title` and `type` are nullable so
 * ancestors the caller is NOT authorized to view can be redacted: the ID is
 * preserved (it's already known to be in the parent chain) but the metadata is
 * hidden. Callers render redacted entries as a neutral placeholder (e.g. "…")
 * rather than leaking the ancestor's title/type.
 */
export interface BreadcrumbEntry {
  id: string;
  title: string | null;
  type: PageType | null;
}

export interface PagePayload {
  page: Page;
  breadcrumb: BreadcrumbEntry[];
  /**
   * Per-page-type context loaded with the page. Shape varies by page type.
   * Server components for a given route consume only the keys their page type
   * needs; the rest stay undefined.
   */
  context: PagePayloadContext;
}

export interface ChannelMessageSummary {
  id: string;
  pageId: string;
  userId: string;
  content: string;
  createdAt: string;
  isActive: boolean;
}

export interface ChatMessageSummary {
  id: string;
  pageId: string;
  conversationId: string;
  role: string;
  content: string;
  createdAt: string;
  isActive: boolean;
  userId: string | null;
}

export interface PagePayloadContext {
  channelMessages?: ChannelMessageSummary[];
  chatMessages?: ChatMessageSummary[];
  /**
   * For SHEET pages, the canonical sheet content is `page.content` (a stringified
   * structure). This bag is a placeholder for future per-type sidecars (e.g.,
   * sheet schema, file-blob metadata) so callers can rely on a stable shape.
   */
  sheet?: { contentMode: 'html' | 'markdown' };
  document?: { contentMode: 'html' | 'markdown' };
  file?: {
    fileSize: number | null;
    mimeType: string | null;
    originalFileName: string | null;
    processingStatus: ProcessingStatus | null;
  };
}

export interface AppShellContext {
  /** When set, the active drive's tree is included in the payload. */
  activeDriveId?: string;
  /** When set, the current page's PagePayload is included. */
  currentPageId?: string;
}

export interface ActiveDrivePayload {
  driveId: string;
  tree: PageTreeNode[];
}

export interface AppShell {
  user: AppShellUser;
  connections: ConnectionSummary[];
  drives: DriveSummary[];
  driveMembers: DriveMemberSummary[];
  activeDrive?: ActiveDrivePayload;
  currentPage?: PagePayload;
  /** ISO8601 timestamp of when the shell was loaded (single tx fence). */
  generatedAt: string;
}

// Inbox payload — defined now even though no fetcher exists yet, so the future
// inbox Server Component has the contract ready to hydrate against.
export interface InboxPayload {
  user: AppShellUser;
  items: InboxItem[];
  /**
   * Total unread count across all inbox items, denormalized for the sidebar
   * badge so clients don't have to re-sum on every render.
   */
  totalUnread: number;
  generatedAt: string;
}
