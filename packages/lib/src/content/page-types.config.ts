import { PageType } from '../utils/enums';
import { createEmptySheet, serializeSheetContent } from '../sheets/sheet';

export interface PageTypeCapabilities {
  canAcceptUploads: boolean;
  canBeConverted: boolean;
  supportsRealtime: boolean;
  supportsVersioning: boolean;
  supportsAI: boolean;
}

export interface PageTypeApiValidation {
  requiredFields?: string[];
  optionalFields?: string[];
  customValidation?: (data: any) => { valid: boolean; error?: string };
}

export interface PageTypeConfig {
  type: PageType;
  displayName: string;
  description: string;
  iconName: 'Folder' | 'FileText' | 'MessageSquare' | 'Sparkles' | 'Palette' | 'FileIcon' | 'Table' | 'CheckSquare';
  emoji: string;
  capabilities: PageTypeCapabilities;
  defaultContent: () => any;
  apiValidation?: PageTypeApiValidation;
  uiComponent: string;
  layoutViewType: 'document' | 'folder' | 'channel' | 'ai' | 'canvas';
}

export const PAGE_TYPE_CONFIGS: Record<PageType, PageTypeConfig> = {
  [PageType.FOLDER]: {
    type: PageType.FOLDER,
    displayName: 'Folder',
    description: 'Organize pages in a hierarchical structure',
    iconName: 'Folder',
    emoji: '📁',
    capabilities: {
      canAcceptUploads: true,
      canBeConverted: false,
      supportsRealtime: false,
      supportsVersioning: false,
      supportsAI: false,
    },
    defaultContent: () => ({ children: [] }),
    uiComponent: 'FolderView',
    layoutViewType: 'folder',
  },
  [PageType.DOCUMENT]: {
    type: PageType.DOCUMENT,
    displayName: 'Document',
    description: 'Rich text document with formatting',
    iconName: 'FileText',
    emoji: '📄',
    capabilities: {
      canAcceptUploads: false,
      canBeConverted: true,
      supportsRealtime: true,
      supportsVersioning: true,
      supportsAI: false,
    },
    defaultContent: () => '',
    uiComponent: 'DocumentView',
    layoutViewType: 'document',
  },
  [PageType.CHANNEL]: {
    type: PageType.CHANNEL,
    displayName: 'Channel',
    description: 'Team discussion channel',
    iconName: 'MessageSquare',
    emoji: '💬',
    capabilities: {
      canAcceptUploads: false,
      canBeConverted: false,
      supportsRealtime: true,
      supportsVersioning: false,
      supportsAI: false,
    },
    defaultContent: () => ({ messages: [] }),
    uiComponent: 'ChannelView',
    layoutViewType: 'channel',
  },
  [PageType.AI_CHAT]: {
    type: PageType.AI_CHAT,
    displayName: 'AI Chat',
    description: 'AI-powered conversation space',
    iconName: 'Sparkles',
    emoji: '🤖',
    capabilities: {
      canAcceptUploads: false,
      canBeConverted: false,
      supportsRealtime: true,
      supportsVersioning: false,
      supportsAI: true,
    },
    defaultContent: () => ({ messages: [] }),
    apiValidation: {
      optionalFields: ['systemPrompt', 'enabledTools', 'aiProvider', 'aiModel'],
    },
    uiComponent: 'AiChatView',
    layoutViewType: 'ai',
  },
  [PageType.CANVAS]: {
    type: PageType.CANVAS,
    displayName: 'Canvas',
    description: 'Custom HTML/CSS page',
    iconName: 'Palette',
    emoji: '🎨',
    capabilities: {
      canAcceptUploads: false,
      canBeConverted: false,
      supportsRealtime: false,
      supportsVersioning: true,
      supportsAI: false,
    },
    defaultContent: () => '',
    uiComponent: 'CanvasPageView',
    layoutViewType: 'canvas',
  },
  [PageType.FILE]: {
    type: PageType.FILE,
    displayName: 'File',
    description: 'Uploaded file with metadata',
    iconName: 'FileIcon',
    emoji: '📎',
    capabilities: {
      canAcceptUploads: false,
      canBeConverted: true,
      supportsRealtime: false,
      supportsVersioning: false,
      supportsAI: false,
    },
    defaultContent: () => '',
    uiComponent: 'FileViewer',
    layoutViewType: 'document',
  },
  [PageType.SHEET]: {
    type: PageType.SHEET,
    displayName: 'Sheet',
    description: 'Interactive spreadsheet with formulas',
    iconName: 'Table',
    emoji: '📊',
    capabilities: {
      canAcceptUploads: false,
      canBeConverted: false,
      supportsRealtime: true,
      supportsVersioning: true,
      supportsAI: true,
    },
    defaultContent: () => serializeSheetContent(createEmptySheet()),
    uiComponent: 'SheetView',
    layoutViewType: 'document',
  },
  [PageType.TASK_LIST]: {
    type: PageType.TASK_LIST,
    displayName: 'Task List',
    description: 'Table-based task management',
    iconName: 'CheckSquare',
    emoji: '✅',
    capabilities: {
      canAcceptUploads: false,
      canBeConverted: false,
      supportsRealtime: true,
      supportsVersioning: false,
      supportsAI: true,
    },
    defaultContent: () => JSON.stringify({}),
    uiComponent: 'TaskListView',
    layoutViewType: 'document',
  },
};

// Helper functions
export function getPageTypeConfig(type: PageType): PageTypeConfig {
  return PAGE_TYPE_CONFIGS[type] || PAGE_TYPE_CONFIGS[PageType.DOCUMENT];
}

export function getPageTypeIconName(type: PageType): string {
  return PAGE_TYPE_CONFIGS[type]?.iconName || 'FileText';
}

export function canPageTypeAcceptUploads(type: PageType): boolean {
  return PAGE_TYPE_CONFIGS[type]?.capabilities.canAcceptUploads || false;
}

export function getDefaultContent(type: PageType): string {
  const config = PAGE_TYPE_CONFIGS[type];
  if (!config) return '';

  const content = config.defaultContent();
  // Stringify JSON content for types that return objects
  if (type === PageType.FOLDER || type === PageType.CHANNEL || type === PageType.AI_CHAT) {
    return JSON.stringify(content);
  }
  return content;
}

export function getPageTypeComponent(type: PageType): string {
  return PAGE_TYPE_CONFIGS[type]?.uiComponent || 'DocumentView';
}

export function getLayoutViewType(type: PageType): string {
  return PAGE_TYPE_CONFIGS[type]?.layoutViewType || 'document';
}

export function isDocumentPage(type: PageType): boolean {
  return type === PageType.DOCUMENT;
}

export function isFilePage(type: PageType): boolean {
  return type === PageType.FILE;
}

export function isSheetPage(type: PageType): boolean {
  return type === PageType.SHEET;
}

export function supportsAI(type: PageType): boolean {
  return PAGE_TYPE_CONFIGS[type]?.capabilities.supportsAI || false;
}

export function supportsRealtime(type: PageType): boolean {
  return PAGE_TYPE_CONFIGS[type]?.capabilities.supportsRealtime || false;
}

export function canBeConverted(type: PageType): boolean {
  return PAGE_TYPE_CONFIGS[type]?.capabilities.canBeConverted || false;
}

export function getPageTypeDisplayName(type: PageType): string {
  return PAGE_TYPE_CONFIGS[type]?.displayName || 'Document';
}

export function getPageTypeDescription(type: PageType): string {
  return PAGE_TYPE_CONFIGS[type]?.description || '';
}

export function getPageTypeEmoji(type: PageType): string {
  return PAGE_TYPE_CONFIGS[type]?.emoji || '📄';
}

export function isFolderPage(type: PageType): boolean {
  return type === PageType.FOLDER;
}

export function isCanvasPage(type: PageType): boolean {
  return type === PageType.CANVAS;
}

export function isChannelPage(type: PageType): boolean {
  return type === PageType.CHANNEL;
}

export function isAIChatPage(type: PageType): boolean {
  return type === PageType.AI_CHAT;
}

export function isTaskListPage(type: PageType): boolean {
  return type === PageType.TASK_LIST;
}