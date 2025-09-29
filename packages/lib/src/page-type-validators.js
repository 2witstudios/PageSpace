"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validatePageCreation = validatePageCreation;
exports.canConvertToType = canConvertToType;
exports.canParentHaveChildType = canParentHaveChildType;
exports.validatePageUpdate = validatePageUpdate;
exports.pageTypeRequiresAuth = pageTypeRequiresAuth;
exports.getValidationRules = getValidationRules;
exports.validateAIChatTools = validateAIChatTools;
const enums_1 = require("./enums");
const page_types_config_1 = require("./page-types.config");
const sheet_1 = require("./sheet");
/**
 * Validates page creation data based on page type configuration
 */
function validatePageCreation(type, data) {
    const config = (0, page_types_config_1.getPageTypeConfig)(type);
    const errors = [];
    // Validate required fields
    if (config.apiValidation?.requiredFields) {
        for (const field of config.apiValidation.requiredFields) {
            if (!data[field]) {
                errors.push(`Missing required field: ${field}`);
            }
        }
    }
    // Type-specific validations
    switch (type) {
        case enums_1.PageType.AI_CHAT:
            // Validate AI_CHAT specific fields
            if (data.systemPrompt && typeof data.systemPrompt !== 'string') {
                errors.push('systemPrompt must be a string');
            }
            if (data.enabledTools && !Array.isArray(data.enabledTools)) {
                errors.push('enabledTools must be an array');
            }
            if (data.aiProvider && typeof data.aiProvider !== 'string') {
                errors.push('aiProvider must be a string');
            }
            if (data.aiModel && typeof data.aiModel !== 'string') {
                errors.push('aiModel must be a string');
            }
            break;
        case enums_1.PageType.FILE:
            // FILE type should have file-specific fields
            if (!data.mimeType && !data.filePath) {
                errors.push('FILE type requires either mimeType or filePath');
            }
            break;
        case enums_1.PageType.FOLDER:
            // Folders don't need special validation
            break;
        case enums_1.PageType.DOCUMENT:
            // Documents can have empty content initially
            break;
        case enums_1.PageType.CHANNEL:
            // Channels start with empty messages
            break;
        case enums_1.PageType.CANVAS:
            // Canvas pages can start empty
            break;
        case enums_1.PageType.SHEET:
            if (data.content) {
                try {
                    (0, sheet_1.parseSheetContent)(data.content);
                }
                catch {
                    errors.push('Invalid sheet content');
                }
            }
            break;
    }
    // Run custom validation if defined
    if (config.apiValidation?.customValidation) {
        const customResult = config.apiValidation.customValidation(data);
        if (!customResult.valid && customResult.error) {
            errors.push(customResult.error);
        }
    }
    return {
        valid: errors.length === 0,
        errors,
    };
}
/**
 * Validates if a page type can be converted to another type
 */
function canConvertToType(fromType, toType) {
    // Currently only FILE to DOCUMENT conversion is supported
    if (fromType === enums_1.PageType.FILE && toType === enums_1.PageType.DOCUMENT) {
        return true;
    }
    // Future: Could add more conversion rules
    // e.g., CHANNEL to DOCUMENT (export chat history)
    // e.g., AI_CHAT to DOCUMENT (export conversation)
    return false;
}
/**
 * Validates if a parent can have a child of a specific type
 */
function canParentHaveChildType(parentType, childType) {
    const config = (0, page_types_config_1.getPageTypeConfig)(parentType);
    // Check if parent can have children at all
    if (!config.capabilities.canHaveChildren) {
        return false;
    }
    // Check if this specific child type is allowed
    return config.allowedChildTypes.includes(childType);
}
/**
 * Validates page update data
 */
function validatePageUpdate(type, data) {
    const errors = [];
    // Title validation (common for all types)
    if ('title' in data && typeof data.title !== 'string') {
        errors.push('Title must be a string');
    }
    // Content validation based on type
    if ('content' in data) {
        switch (type) {
            case enums_1.PageType.DOCUMENT:
            case enums_1.PageType.CANVAS:
                if (typeof data.content !== 'string') {
                    errors.push('Content must be a string for document/canvas pages');
                }
                break;
            case enums_1.PageType.CHANNEL:
            case enums_1.PageType.AI_CHAT:
                // These types might have structured content
                if (typeof data.content === 'string') {
                    try {
                        JSON.parse(data.content);
                    }
                    catch {
                        errors.push('Content must be valid JSON for channel/chat pages');
                    }
                }
                break;
            case enums_1.PageType.SHEET:
                if (typeof data.content !== 'string') {
                    errors.push('Content must be a string for sheet pages');
                }
                else {
                    try {
                        (0, sheet_1.parseSheetContent)(data.content);
                    }
                    catch {
                        errors.push('Content must be valid sheet data');
                    }
                }
                break;
        }
    }
    // AI_CHAT specific updates
    if (type === enums_1.PageType.AI_CHAT) {
        if ('systemPrompt' in data && data.systemPrompt !== null && typeof data.systemPrompt !== 'string') {
            errors.push('systemPrompt must be a string or null');
        }
        if ('enabledTools' in data && data.enabledTools !== null && !Array.isArray(data.enabledTools)) {
            errors.push('enabledTools must be an array or null');
        }
    }
    return {
        valid: errors.length === 0,
        errors,
    };
}
/**
 * Checks if a page type requires authentication
 */
function pageTypeRequiresAuth(type) {
    const config = (0, page_types_config_1.getPageTypeConfig)(type);
    return config.capabilities.requiresAuth;
}
/**
 * Gets validation rules for a page type
 */
function getValidationRules(type) {
    const config = (0, page_types_config_1.getPageTypeConfig)(type);
    return {
        requiredFields: config.apiValidation?.requiredFields || [],
        optionalFields: config.apiValidation?.optionalFields || [],
        capabilities: config.capabilities,
    };
}
/**
 * Validates AI_CHAT tools against available tools
 * Note: The actual tool validation should be done in the app layer
 * where the tools are defined. This function just provides the interface.
 */
function validateAIChatTools(enabledTools, availableToolNames) {
    const errors = [];
    if (!enabledTools || enabledTools.length === 0) {
        return { valid: true, errors: [] };
    }
    const invalidTools = enabledTools.filter((toolName) => !availableToolNames.includes(toolName));
    if (invalidTools.length > 0) {
        errors.push(`Invalid tools specified: ${invalidTools.join(', ')}. Available tools: ${availableToolNames.join(', ')}`);
    }
    return {
        valid: errors.length === 0,
        errors,
    };
}
