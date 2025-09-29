import { PageType } from './enums';
export interface PageTypeCapabilities {
    canHaveChildren: boolean;
    canAcceptUploads: boolean;
    canBeConverted: boolean;
    requiresAuth: boolean;
    supportsRealtime: boolean;
    supportsVersioning: boolean;
    supportsAI: boolean;
}
export interface PageTypeApiValidation {
    requiredFields?: string[];
    optionalFields?: string[];
    customValidation?: (data: any) => {
        valid: boolean;
        error?: string;
    };
}
export interface PageTypeConfig {
    type: PageType;
    displayName: string;
    description: string;
    iconName: 'Folder' | 'FileText' | 'MessageSquare' | 'Sparkles' | 'Palette' | 'FileIcon' | 'Table';
    emoji: string;
    capabilities: PageTypeCapabilities;
    defaultContent: () => any;
    allowedChildTypes: PageType[];
    apiValidation?: PageTypeApiValidation;
    uiComponent: string;
    layoutViewType: 'document' | 'folder' | 'channel' | 'ai' | 'canvas';
}
export declare const PAGE_TYPE_CONFIGS: Record<PageType, PageTypeConfig>;
export declare function getPageTypeConfig(type: PageType): PageTypeConfig;
export declare function getPageTypeIconName(type: PageType): string;
export declare function canPageTypeHaveChildren(type: PageType): boolean;
export declare function canPageTypeAcceptUploads(type: PageType): boolean;
export declare function getDefaultContent(type: PageType): any;
export declare function getPageTypeComponent(type: PageType): string;
export declare function getLayoutViewType(type: PageType): string;
export declare function isDocumentPage(type: PageType): boolean;
export declare function isFilePage(type: PageType): boolean;
export declare function isSheetPage(type: PageType): boolean;
export declare function supportsAI(type: PageType): boolean;
export declare function requiresAuth(type: PageType): boolean;
export declare function supportsRealtime(type: PageType): boolean;
export declare function canBeConverted(type: PageType): boolean;
export declare function getAllowedChildTypes(type: PageType): PageType[];
export declare function getPageTypeDisplayName(type: PageType): string;
export declare function getPageTypeDescription(type: PageType): string;
export declare function getPageTypeEmoji(type: PageType): string;
export declare function isFolderPage(type: PageType): boolean;
export declare function isCanvasPage(type: PageType): boolean;
export declare function isChannelPage(type: PageType): boolean;
export declare function isAIChatPage(type: PageType): boolean;
//# sourceMappingURL=page-types.config.d.ts.map