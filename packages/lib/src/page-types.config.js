"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PAGE_TYPE_CONFIGS = void 0;
exports.getPageTypeConfig = getPageTypeConfig;
exports.getPageTypeIconName = getPageTypeIconName;
exports.canPageTypeHaveChildren = canPageTypeHaveChildren;
exports.canPageTypeAcceptUploads = canPageTypeAcceptUploads;
exports.getDefaultContent = getDefaultContent;
exports.getPageTypeComponent = getPageTypeComponent;
exports.getLayoutViewType = getLayoutViewType;
exports.isDocumentPage = isDocumentPage;
exports.isFilePage = isFilePage;
exports.isSheetPage = isSheetPage;
exports.supportsAI = supportsAI;
exports.requiresAuth = requiresAuth;
exports.supportsRealtime = supportsRealtime;
exports.canBeConverted = canBeConverted;
exports.getAllowedChildTypes = getAllowedChildTypes;
exports.getPageTypeDisplayName = getPageTypeDisplayName;
exports.getPageTypeDescription = getPageTypeDescription;
exports.getPageTypeEmoji = getPageTypeEmoji;
exports.isFolderPage = isFolderPage;
exports.isCanvasPage = isCanvasPage;
exports.isChannelPage = isChannelPage;
exports.isAIChatPage = isAIChatPage;
const enums_1 = require("./enums");
const sheet_1 = require("./sheet");
exports.PAGE_TYPE_CONFIGS = {
    [enums_1.PageType.FOLDER]: {
        type: enums_1.PageType.FOLDER,
        displayName: 'Folder',
        description: 'Organize pages in a hierarchical structure',
        iconName: 'Folder',
        emoji: '📁',
        capabilities: {
            canHaveChildren: true,
            canAcceptUploads: true,
            canBeConverted: false,
            requiresAuth: false,
            supportsRealtime: false,
            supportsVersioning: false,
            supportsAI: false,
        },
        defaultContent: () => ({ children: [] }),
        allowedChildTypes: Object.values(enums_1.PageType),
        uiComponent: 'FolderView',
        layoutViewType: 'folder',
    },
    [enums_1.PageType.DOCUMENT]: {
        type: enums_1.PageType.DOCUMENT,
        displayName: 'Document',
        description: 'Rich text document with formatting',
        iconName: 'FileText',
        emoji: '📄',
        capabilities: {
            canHaveChildren: false,
            canAcceptUploads: false,
            canBeConverted: true,
            requiresAuth: false,
            supportsRealtime: true,
            supportsVersioning: true,
            supportsAI: false,
        },
        defaultContent: () => '',
        allowedChildTypes: [],
        uiComponent: 'DocumentView',
        layoutViewType: 'document',
    },
    [enums_1.PageType.CHANNEL]: {
        type: enums_1.PageType.CHANNEL,
        displayName: 'Channel',
        description: 'Team discussion channel',
        iconName: 'MessageSquare',
        emoji: '💬',
        capabilities: {
            canHaveChildren: false,
            canAcceptUploads: false,
            canBeConverted: false,
            requiresAuth: true,
            supportsRealtime: true,
            supportsVersioning: false,
            supportsAI: false,
        },
        defaultContent: () => ({ messages: [] }),
        allowedChildTypes: [],
        uiComponent: 'ChannelView',
        layoutViewType: 'channel',
    },
    [enums_1.PageType.AI_CHAT]: {
        type: enums_1.PageType.AI_CHAT,
        displayName: 'AI Chat',
        description: 'AI-powered conversation space',
        iconName: 'Sparkles',
        emoji: '🤖',
        capabilities: {
            canHaveChildren: false,
            canAcceptUploads: false,
            canBeConverted: false,
            requiresAuth: true,
            supportsRealtime: true,
            supportsVersioning: false,
            supportsAI: true,
        },
        defaultContent: () => ({ messages: [] }),
        allowedChildTypes: [],
        apiValidation: {
            optionalFields: ['systemPrompt', 'enabledTools', 'aiProvider', 'aiModel'],
        },
        uiComponent: 'AiChatView',
        layoutViewType: 'ai',
    },
    [enums_1.PageType.CANVAS]: {
        type: enums_1.PageType.CANVAS,
        displayName: 'Canvas',
        description: 'Custom HTML/CSS page',
        iconName: 'Palette',
        emoji: '🎨',
        capabilities: {
            canHaveChildren: false,
            canAcceptUploads: false,
            canBeConverted: false,
            requiresAuth: false,
            supportsRealtime: false,
            supportsVersioning: true,
            supportsAI: false,
        },
        defaultContent: () => '',
        allowedChildTypes: [],
        uiComponent: 'CanvasPageView',
        layoutViewType: 'canvas',
    },
    [enums_1.PageType.FILE]: {
        type: enums_1.PageType.FILE,
        displayName: 'File',
        description: 'Uploaded file with metadata',
        iconName: 'FileIcon',
        emoji: '📎',
        capabilities: {
            canHaveChildren: false,
            canAcceptUploads: false,
            canBeConverted: true,
            requiresAuth: false,
            supportsRealtime: false,
            supportsVersioning: false,
            supportsAI: false,
        },
        defaultContent: () => '',
        allowedChildTypes: [],
        uiComponent: 'FileViewer',
        layoutViewType: 'document',
    },
    [enums_1.PageType.SHEET]: {
        type: enums_1.PageType.SHEET,
        displayName: 'Sheet',
        description: 'Interactive spreadsheet with formulas',
        iconName: 'Table',
        emoji: '📊',
        capabilities: {
            canHaveChildren: false,
            canAcceptUploads: false,
            canBeConverted: false,
            requiresAuth: false,
            supportsRealtime: true,
            supportsVersioning: true,
            supportsAI: true,
        },
        defaultContent: () => (0, sheet_1.serializeSheetContent)((0, sheet_1.createEmptySheet)()),
        allowedChildTypes: [],
        uiComponent: 'SheetView',
        layoutViewType: 'document',
    },
};
// Helper functions
function getPageTypeConfig(type) {
    return exports.PAGE_TYPE_CONFIGS[type] || exports.PAGE_TYPE_CONFIGS[enums_1.PageType.DOCUMENT];
}
function getPageTypeIconName(type) {
    return exports.PAGE_TYPE_CONFIGS[type]?.iconName || 'FileText';
}
function canPageTypeHaveChildren(type) {
    return exports.PAGE_TYPE_CONFIGS[type]?.capabilities.canHaveChildren || false;
}
function canPageTypeAcceptUploads(type) {
    return exports.PAGE_TYPE_CONFIGS[type]?.capabilities.canAcceptUploads || false;
}
function getDefaultContent(type) {
    const config = exports.PAGE_TYPE_CONFIGS[type];
    if (!config)
        return '';
    const content = config.defaultContent();
    // For CHANNEL and AI_CHAT, return stringified JSON for consistency
    if (type === enums_1.PageType.CHANNEL || type === enums_1.PageType.AI_CHAT) {
        return JSON.stringify(content);
    }
    return content;
}
function getPageTypeComponent(type) {
    return exports.PAGE_TYPE_CONFIGS[type]?.uiComponent || 'DocumentView';
}
function getLayoutViewType(type) {
    return exports.PAGE_TYPE_CONFIGS[type]?.layoutViewType || 'document';
}
function isDocumentPage(type) {
    return type === enums_1.PageType.DOCUMENT;
}
function isFilePage(type) {
    return type === enums_1.PageType.FILE;
}
function isSheetPage(type) {
    return type === enums_1.PageType.SHEET;
}
function supportsAI(type) {
    return exports.PAGE_TYPE_CONFIGS[type]?.capabilities.supportsAI || false;
}
function requiresAuth(type) {
    return exports.PAGE_TYPE_CONFIGS[type]?.capabilities.requiresAuth || false;
}
function supportsRealtime(type) {
    return exports.PAGE_TYPE_CONFIGS[type]?.capabilities.supportsRealtime || false;
}
function canBeConverted(type) {
    return exports.PAGE_TYPE_CONFIGS[type]?.capabilities.canBeConverted || false;
}
function getAllowedChildTypes(type) {
    return exports.PAGE_TYPE_CONFIGS[type]?.allowedChildTypes || [];
}
function getPageTypeDisplayName(type) {
    return exports.PAGE_TYPE_CONFIGS[type]?.displayName || 'Document';
}
function getPageTypeDescription(type) {
    return exports.PAGE_TYPE_CONFIGS[type]?.description || '';
}
function getPageTypeEmoji(type) {
    return exports.PAGE_TYPE_CONFIGS[type]?.emoji || '📄';
}
function isFolderPage(type) {
    return type === enums_1.PageType.FOLDER;
}
function isCanvasPage(type) {
    return type === enums_1.PageType.CANVAS;
}
function isChannelPage(type) {
    return type === enums_1.PageType.CHANNEL;
}
function isAIChatPage(type) {
    return type === enums_1.PageType.AI_CHAT;
}
