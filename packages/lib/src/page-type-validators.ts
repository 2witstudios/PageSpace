import { PageType } from './enums';
import { getPageTypeConfig } from './page-types.config';
import { parseSheetContent, SHEET_DEFAULT_ROWS, SHEET_DEFAULT_COLUMNS } from './sheet';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Helper to validate sheet content is actually valid, not just a fallback empty sheet
 */
function isValidSheetContent(content: string): boolean {
  if (!content || typeof content !== 'string') {
    return false;
  }

  const trimmed = content.trim();
  if (!trimmed) {
    return false;
  }

  // Try to parse it
  const parsed = parseSheetContent(content);

  // If the content was non-empty but resulted in an empty default sheet,
  // it's likely invalid input that was sanitized
  const isDefaultEmptySheet =
    parsed.rowCount === SHEET_DEFAULT_ROWS &&
    parsed.columnCount === SHEET_DEFAULT_COLUMNS &&
    Object.keys(parsed.cells).length === 0;

  // If content was provided but we got default empty sheet, it's invalid
  if (trimmed !== '' && isDefaultEmptySheet) {
    // Check if it's valid JSON or SheetDoc format
    if (trimmed.startsWith('#%PAGESPACE_SHEETDOC')) {
      return true; // SheetDoc format is valid
    }

    try {
      const json = JSON.parse(trimmed);
      // Valid JSON with sheet structure
      if (json && typeof json === 'object') {
        return true;
      }
    } catch {
      // Not valid JSON
      return false;
    }

    return false;
  }

  return true;
}

/**
 * Validates page creation data based on page type configuration
 */
export function validatePageCreation(
  type: PageType,
  data: any
): ValidationResult {
  const config = getPageTypeConfig(type);
  const errors: string[] = [];

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
    case PageType.AI_CHAT:
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

    case PageType.FILE:
      // FILE type should have file-specific fields
      if (!data.mimeType && !data.filePath) {
        errors.push('FILE type requires either mimeType or filePath');
      }
      break;

    case PageType.FOLDER:
      // Folders don't need special validation
      break;

    case PageType.DOCUMENT:
      // Documents can have empty content initially
      break;

    case PageType.CHANNEL:
      // Channels start with empty messages
      break;

    case PageType.CANVAS:
      // Canvas pages can start empty
      break;

    case PageType.SHEET:
      if (data.content) {
        if (!isValidSheetContent(data.content)) {
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
export function canConvertToType(fromType: PageType, toType: PageType): boolean {
  // Currently only FILE to DOCUMENT conversion is supported
  if (fromType === PageType.FILE && toType === PageType.DOCUMENT) {
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
export function canParentHaveChildType(
  parentType: PageType,
  childType: PageType
): boolean {
  const config = getPageTypeConfig(parentType);
  
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
export function validatePageUpdate(
  type: PageType,
  data: any
): ValidationResult {
  const errors: string[] = [];

  // Title validation (common for all types)
  if ('title' in data && typeof data.title !== 'string') {
    errors.push('Title must be a string');
  }

  // Content validation based on type
  if ('content' in data) {
    switch (type) {
      case PageType.DOCUMENT:
      case PageType.CANVAS:
        if (typeof data.content !== 'string') {
          errors.push('Content must be a string for document/canvas pages');
        }
        break;
      
      case PageType.CHANNEL:
      case PageType.AI_CHAT:
        // These types might have structured content
        if (typeof data.content === 'string') {
          try {
            JSON.parse(data.content);
          } catch {
            errors.push('Content must be valid JSON for channel/chat pages');
          }
        }
        break;

      case PageType.SHEET:
        if (typeof data.content !== 'string') {
          errors.push('Content must be a string for sheet pages');
        } else {
          if (!isValidSheetContent(data.content)) {
            errors.push('Content must be valid sheet data');
          }
        }
        break;
    }
  }

  // AI_CHAT specific updates
  if (type === PageType.AI_CHAT) {
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
 * Gets validation rules for a page type
 */
export function getValidationRules(type: PageType) {
  const config = getPageTypeConfig(type);
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
export function validateAIChatTools(
  enabledTools: string[] | null | undefined,
  availableToolNames: string[]
): ValidationResult {
  const errors: string[] = [];
  
  if (!enabledTools || enabledTools.length === 0) {
    return { valid: true, errors: [] };
  }
  
  const invalidTools = enabledTools.filter((toolName: string) => !availableToolNames.includes(toolName));
  
  if (invalidTools.length > 0) {
    errors.push(`Invalid tools specified: ${invalidTools.join(', ')}. Available tools: ${availableToolNames.join(', ')}`);
  }
  
  return {
    valid: errors.length === 0,
    errors,
  };
}