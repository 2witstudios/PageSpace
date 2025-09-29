import { PageType } from './enums';
export interface ValidationResult {
    valid: boolean;
    errors: string[];
}
/**
 * Validates page creation data based on page type configuration
 */
export declare function validatePageCreation(type: PageType, data: any): ValidationResult;
/**
 * Validates if a page type can be converted to another type
 */
export declare function canConvertToType(fromType: PageType, toType: PageType): boolean;
/**
 * Validates if a parent can have a child of a specific type
 */
export declare function canParentHaveChildType(parentType: PageType, childType: PageType): boolean;
/**
 * Validates page update data
 */
export declare function validatePageUpdate(type: PageType, data: any): ValidationResult;
/**
 * Checks if a page type requires authentication
 */
export declare function pageTypeRequiresAuth(type: PageType): boolean;
/**
 * Gets validation rules for a page type
 */
export declare function getValidationRules(type: PageType): {
    requiredFields: string[];
    optionalFields: string[];
    capabilities: import("./page-types.config").PageTypeCapabilities;
};
/**
 * Validates AI_CHAT tools against available tools
 * Note: The actual tool validation should be done in the app layer
 * where the tools are defined. This function just provides the interface.
 */
export declare function validateAIChatTools(enabledTools: string[] | null | undefined, availableToolNames: string[]): ValidationResult;
//# sourceMappingURL=page-type-validators.d.ts.map