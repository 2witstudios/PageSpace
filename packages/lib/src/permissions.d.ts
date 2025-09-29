/**
 * Get user access level for a page
 * Simple permission check - no inheritance, direct permissions only
 */
export declare function getUserAccessLevel(userId: string, pageId: string, options?: {
    silent?: boolean;
}): Promise<{
    canView: boolean;
    canEdit: boolean;
    canShare: boolean;
    canDelete: boolean;
} | null>;
/**
 * Check if user can view a page
 */
export declare function canUserViewPage(userId: string, pageId: string): Promise<boolean>;
/**
 * Check if user can edit a page
 */
export declare function canUserEditPage(userId: string, pageId: string): Promise<boolean>;
/**
 * Check if user can share a page
 */
export declare function canUserSharePage(userId: string, pageId: string): Promise<boolean>;
/**
 * Check if user can delete a page
 */
export declare function canUserDeletePage(userId: string, pageId: string): Promise<boolean>;
/**
 * Check if user is a member of a drive
 */
export declare function isUserDriveMember(userId: string, driveId: string): Promise<boolean>;
/**
 * Get all pages a user has access to in a drive
 */
export declare function getUserAccessiblePagesInDrive(userId: string, driveId: string): Promise<string[]>;
/**
 * Page with permission details type
 */
export type PageWithPermissions = {
    id: string;
    title: string;
    type: string;
    parentId: string | null;
    position: number;
    isTrashed: boolean;
    permissions: {
        canView: boolean;
        canEdit: boolean;
        canShare: boolean;
        canDelete: boolean;
    };
};
/**
 * Get all pages a user has access to in a drive with full page details and permissions
 * Optimized to avoid N+1 queries by using batch permission checks
 */
export declare function getUserAccessiblePagesInDriveWithDetails(userId: string, driveId: string): Promise<PageWithPermissions[]>;
/**
 * Grant permissions to a user for a page
 */
export declare function grantPagePermissions(pageId: string, userId: string, permissions: {
    canView: boolean;
    canEdit: boolean;
    canShare: boolean;
    canDelete?: boolean;
}, grantedBy: string): Promise<void>;
/**
 * Revoke all permissions for a user on a page
 */
export declare function revokePagePermissions(pageId: string, userId: string): Promise<void>;
/**
 * Check if user has access to a drive by drive ID
 * Returns true if user owns the drive, is a member of the drive, or has any page permissions in the drive
 */
export declare function getUserDriveAccess(userId: string, driveId: string, options?: {
    silent?: boolean;
}): Promise<boolean>;
//# sourceMappingURL=permissions.d.ts.map