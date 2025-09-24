# Page Type System Refactoring Analysis

## Executive Summary

The current page type handling in PageSpace is distributed across multiple files with significant redundancy and no centralized configuration. This document provides a comprehensive analysis of the existing implementation and a detailed refactoring plan to improve maintainability, reduce duplication, and make the system more extensible.

## Current Page Types

The system currently supports 7 page types defined in `/packages/lib/src/enums.ts:1-8`:
- `FOLDER` - Hierarchical containers for other pages
- `DOCUMENT` - Rich text documents
- `CHANNEL` - Team discussion channels
- `AI_CHAT` - AI conversation spaces with agent configuration
- `CANVAS` - Custom HTML/CSS pages
- `FILE` - Uploaded files with metadata
- `SHEET` - Interactive spreadsheets with formula support

Database enum definition: `/packages/db/src/schema/core.ts:5`

## Identified Issues and Redundancies

### 1. Duplicated Icon Mapping Logic (4 locations)

**Files with duplicate icon selection logic:**
- `/apps/web/src/components/layout/left-sidebar/page-tree/TreeNode.tsx:92-106`
  - Function: `getIcon(type: PageType)`
  - Returns icon components
  
- `/apps/web/src/components/layout/middle-content/page-views/drive/Icon.tsx:20-35`
  - Function: `getIconComponent(type: PageType)`
  - Identical logic to TreeNode
  
- `/apps/web/src/components/layout/middle-content/page-views/folder/Icon.tsx:19-32`
  - Function: `getIconComponent(type: PageType)`
  - **Missing FILE type handling**
  
- `/apps/web/src/components/members/PermissionsGrid.tsx:82-91`
  - Function: `getPageIcon(type: string)`
  - **Uses Bot icon for AI_CHAT instead of Sparkles**
  - **Has CANVAS type that others don't**

**Issue:** Each file independently maps PageType to Lucide icons with inconsistencies.

### 2. Duplicated Component Selection Logic (2 locations)

**Primary component router:**
- `/apps/web/src/components/layout/middle-content/index.tsx:39-54`
  - Main switch statement for page type components
  - Returns components with `key={page.id}` prop

**Secondary component router:**
- `/apps/web/src/components/layout/middle-content/CenterPanel.tsx:64-78`
  - Duplicate switch statement
  - Same logic without key props

**Issue:** Identical logic maintained in two places.

### 3. Inconsistent Initial Content Generation

**Files handling initial content:**
- `/apps/web/src/components/layout/left-sidebar/CreatePageDialog.tsx:91-98`
  ```typescript
  if (type === 'DOCUMENT') content = '';
  else if (type === 'CHANNEL' || type === 'AI_CHAT') content = JSON.stringify({ messages: [] });
  else if (type === 'CANVAS') content = '';
  ```

- `/apps/web/src/app/api/pages/route.ts:91-135`
  - Duplicates content initialization logic
  - Contains type-specific validation for AI_CHAT tools

### 4. Type-Specific Behavior Scattered

**Permission/capability checks:**
- `/apps/web/src/components/layout/left-sidebar/page-tree/TreeNode.tsx:194-197`
  - No explicit folder check found in current version
  - File drag behavior handled via `dragState.isExternalFile`

**UI behavior checks:**
- `/apps/web/src/components/layout/middle-content/content-header/index.tsx:32-33`
  ```typescript
  const isDocumentPage = page?.type === PageType.DOCUMENT;
  const isFilePage = page?.type === PageType.FILE;
  ```
  - Lines 42, 73, 76-77: Conditional rendering based on type

**Layout Store Mapping:**
- `/apps/web/src/stores/useLayoutStore.ts:81-89`
  - Maps PageType to view types for layout management
  - FILE type uses 'document' view type

### 5. Missing Type Configuration

**No centralized definition for:**
- Display names (user-friendly labels)
- Descriptions (what each type is for)
- Capabilities (canHaveChildren, acceptsUploads, etc.)
- Default content structure
- Allowed child types
- Icon associations
- UI component mappings
- Type-specific validations

### 6. API Validation Fragmentation

**Type-specific validations:**
- `/apps/web/src/app/api/pages/route.ts:95-115`
  - AI_CHAT specific tool validation
  - Type-specific field restrictions

- `/apps/web/src/app/api/upload/route.ts:101`
  - FILE type creation: `type: PageType.FILE`

- `/apps/web/src/app/api/files/[id]/download/route.ts:38`
  - FILE type verification: `if (page.type !== PageType.FILE)`

- `/apps/web/src/app/api/files/[id]/view/route.ts:38`
  - FILE type verification

- `/apps/web/src/app/api/files/[id]/convert-to-document/route.ts:52,103`
  - FILE to DOCUMENT conversion logic

### 7. Content Parsing Logic

**Page Content Parser:**
- `/packages/lib/src/page-content-parser.ts:36-57`
  - Type-specific content extraction
  - Different handling for DOCUMENT, CHANNEL, FOLDER types

## Impact Analysis

### Files That Will Be Affected (31 files)

#### Core Definition Files (2)
1. `/packages/lib/src/enums.ts` - Original enum definition
2. `/packages/db/src/schema/core.ts` - Database enum definition

#### UI Components (15 files)
1. `/apps/web/src/components/layout/middle-content/index.tsx`
2. `/apps/web/src/components/layout/middle-content/CenterPanel.tsx`
3. `/apps/web/src/components/layout/middle-content/content-header/index.tsx`
4. `/apps/web/src/components/layout/middle-content/content-header/EditorToggles.tsx`
5. `/apps/web/src/components/layout/middle-content/page-views/drive/Icon.tsx`
6. `/apps/web/src/components/layout/middle-content/page-views/folder/Icon.tsx`
7. `/apps/web/src/components/layout/middle-content/page-views/folder/FolderView.tsx`
8. `/apps/web/src/components/layout/middle-content/page-views/file/FileViewer.tsx`
9. `/apps/web/src/components/layout/middle-content/page-views/ai-page/AiChatView.tsx`
10. `/apps/web/src/components/layout/middle-content/page-views/canvas/CanvasPageView.tsx`
11. `/apps/web/src/components/layout/left-sidebar/CreatePageDialog.tsx`
12. `/apps/web/src/components/layout/left-sidebar/page-tree/TreeNode.tsx`
13. `/apps/web/src/components/members/PermissionsGrid.tsx`
14. `/apps/web/src/components/ai/ToolCallRenderer.tsx`
15. `/apps/web/src/stores/useLayoutStore.ts`

#### API Routes (8 files)
1. `/apps/web/src/app/api/pages/route.ts`
2. `/apps/web/src/app/api/pages/[pageId]/route.ts`
3. `/apps/web/src/app/api/upload/route.ts`
4. `/apps/web/src/app/api/files/[id]/download/route.ts`
5. `/apps/web/src/app/api/files/[id]/view/route.ts`
6. `/apps/web/src/app/api/files/[id]/convert-to-document/route.ts`
7. `/apps/web/src/app/api/drives/[driveId]/pages/route.ts`
8. `/apps/web/src/app/api/pages/[pageId]/restore/route.ts`

#### AI Tools & Utilities (6 files)
1. `/apps/web/src/lib/ai/tools/page-write-tools.ts`
2. `/apps/web/src/lib/ai/tools/page-read-tools.ts`
3. `/apps/web/src/lib/ai/tools/agent-tools.ts`
4. `/apps/web/src/lib/ai/tools/batch-operations-tools.ts`
5. `/apps/web/src/lib/ai/role-prompts.ts`
6. `/packages/lib/src/page-content-parser.ts`

## Proposed Solution

### 1. Create Centralized Configuration

**New file: `/packages/lib/src/page-types.config.ts`**

```typescript
import { 
  FileText, Folder, MessageSquare, 
  Sparkles, Palette, FileIcon, Bot 
} from 'lucide-react';
import { PageType } from './enums';

export interface PageTypeConfig {
  type: PageType;
  displayName: string;
  description: string;
  icon: any; // Lucide icon component
  capabilities: {
    canHaveChildren: boolean;
    canAcceptUploads: boolean;
    canBeConverted: boolean;
    requiresAuth: boolean;
    supportsRealtime: boolean;
    supportsVersioning: boolean;
    supportsAI: boolean;
  };
  defaultContent: () => any;
  allowedChildTypes: PageType[];
  apiValidation?: {
    requiredFields?: string[];
    optionalFields?: string[];
    customValidation?: (data: any) => boolean;
  };
  uiComponent: string; // Component name to render
  layoutViewType: 'document' | 'folder' | 'channel' | 'ai' | 'canvas';
}

export const PAGE_TYPE_CONFIGS: Record<PageType, PageTypeConfig> = {
  [PageType.FOLDER]: {
    type: PageType.FOLDER,
    displayName: 'Folder',
    description: 'Organize pages in a hierarchical structure',
    icon: Folder,
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
    allowedChildTypes: Object.values(PageType),
    uiComponent: 'FolderView',
    layoutViewType: 'folder',
  },
  [PageType.DOCUMENT]: {
    type: PageType.DOCUMENT,
    displayName: 'Document',
    description: 'Rich text document with formatting',
    icon: FileText,
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
  [PageType.CHANNEL]: {
    type: PageType.CHANNEL,
    displayName: 'Channel',
    description: 'Team discussion channel',
    icon: MessageSquare,
    capabilities: {
      canHaveChildren: false,
      canAcceptUploads: false,
      canBeConverted: false,
      requiresAuth: true,
      supportsRealtime: true,
      supportsVersioning: false,
      supportsAI: false,
    },
    defaultContent: () => JSON.stringify({ messages: [] }),
    allowedChildTypes: [],
    uiComponent: 'ChannelView',
    layoutViewType: 'channel',
  },
  [PageType.AI_CHAT]: {
    type: PageType.AI_CHAT,
    displayName: 'AI Chat',
    description: 'AI-powered conversation space',
    icon: Sparkles, // Note: PermissionsGrid uses Bot icon
    capabilities: {
      canHaveChildren: false,
      canAcceptUploads: false,
      canBeConverted: false,
      requiresAuth: true,
      supportsRealtime: true,
      supportsVersioning: false,
      supportsAI: true,
    },
    defaultContent: () => JSON.stringify({ messages: [] }),
    allowedChildTypes: [],
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
    icon: Palette,
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
  [PageType.FILE]: {
    type: PageType.FILE,
    displayName: 'File',
    description: 'Uploaded file with metadata',
    icon: FileIcon,
    capabilities: {
      canHaveChildren: false,
      canAcceptUploads: false,
      canBeConverted: true, // Can convert to DOCUMENT
      requiresAuth: false,
      supportsRealtime: false,
      supportsVersioning: false,
      supportsAI: false,
    },
    defaultContent: () => '',
    allowedChildTypes: [],
    uiComponent: 'FileViewer',
    layoutViewType: 'document', // Uses document view for files
  },
};

// Helper functions
export function getPageTypeConfig(type: PageType): PageTypeConfig {
  return PAGE_TYPE_CONFIGS[type];
}

export function getPageTypeIcon(type: PageType) {
  return PAGE_TYPE_CONFIGS[type]?.icon || FileText;
}

export function canPageTypeHaveChildren(type: PageType): boolean {
  return PAGE_TYPE_CONFIGS[type]?.capabilities.canHaveChildren || false;
}

export function getDefaultContent(type: PageType): any {
  return PAGE_TYPE_CONFIGS[type]?.defaultContent() || '';
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

export function supportsAI(type: PageType): boolean {
  return PAGE_TYPE_CONFIGS[type]?.capabilities.supportsAI || false;
}
```

### 2. Create Unified Icon Component

**New file: `/apps/web/src/components/common/PageTypeIcon.tsx`**

```typescript
import { getPageTypeIcon } from '@pagespace/lib/page-types.config';
import { PageType } from '@pagespace/lib/client';

interface PageTypeIconProps {
  type: PageType;
  className?: string;
}

export function PageTypeIcon({ type, className }: PageTypeIconProps) {
  const Icon = getPageTypeIcon(type);
  return <Icon className={className} />;
}
```

### 3. Refactor Component Selection

**Update: `/apps/web/src/components/layout/middle-content/index.tsx`**

```typescript
import { getPageTypeComponent } from '@pagespace/lib/page-types.config';
import * as PageViews from './page-views';

// Dynamic component selection
const componentName = getPageTypeComponent(page.type);
const ViewComponent = PageViews[componentName];
return <ViewComponent key={page.id} page={page} />;
```

### 4. Centralize Validation Logic

**New file: `/packages/lib/src/page-type-validators.ts`**

```typescript
import { PageType } from './enums';
import { getPageTypeConfig } from './page-types.config';

export function validatePageCreation(
  type: PageType, 
  data: any
): { valid: boolean; errors: string[] } {
  const config = getPageTypeConfig(type);
  const errors: string[] = [];
  
  // Check required fields
  if (config.apiValidation?.requiredFields) {
    for (const field of config.apiValidation.requiredFields) {
      if (!data[field]) {
        errors.push(`Missing required field: ${field}`);
      }
    }
  }
  
  // Custom validation
  if (config.apiValidation?.customValidation) {
    if (!config.apiValidation.customValidation(data)) {
      errors.push(`Custom validation failed for type ${type}`);
    }
  }
  
  return { valid: errors.length === 0, errors };
}

export function canConvertToType(fromType: PageType, toType: PageType): boolean {
  // Define conversion rules
  if (fromType === PageType.FILE && toType === PageType.DOCUMENT) {
    return true;
  }
  return false;
}
```

## Implementation Plan

### Phase 1: Create Core Configuration (Week 1)
1. Create `/packages/lib/src/page-types.config.ts`
2. Create `/packages/lib/src/page-type-validators.ts`
3. Create `/apps/web/src/components/common/PageTypeIcon.tsx`
4. Add tests for configuration and validators

### Phase 2: Replace Icon Logic (Week 1)
1. Update TreeNode.tsx (lines 92-106) to use `PageTypeIcon`
2. Update drive/Icon.tsx (lines 20-35)
3. Update folder/Icon.tsx (lines 19-32)
4. Update PermissionsGrid.tsx (lines 82-91)
5. Remove duplicate `getIcon` functions

### Phase 3: Refactor Component Selection (Week 2)
1. Update `/apps/web/src/components/layout/middle-content/index.tsx` (lines 39-54)
2. Update `/apps/web/src/components/layout/middle-content/CenterPanel.tsx` (lines 64-78)
3. Create component registry/export pattern
4. Test all page type views

### Phase 4: Centralize API Validation (Week 2)
1. Update `/apps/web/src/app/api/pages/route.ts` (lines 95-115)
2. Update file-related API routes
3. Remove duplicate validation logic

### Phase 5: Update Content Initialization (Week 3)
1. Update `CreatePageDialog` (lines 91-98) to use `getDefaultContent`
2. Update API routes to use centralized defaults
3. Update `useLayoutStore.ts` (lines 81-89) to use config
4. Test all page creation flows

### Phase 6: Documentation and Testing (Week 3)
1. Update developer documentation
2. Add comprehensive tests
3. Performance testing
4. Migration guide for future page types

## Benefits of Refactoring

### Quantifiable Improvements
- **Code Reduction**: ~60% reduction in duplicate code (estimated 400+ lines removed)
- **Consistency**: Resolves icon inconsistencies (AI_CHAT Bot vs Sparkles)
- **Maintenance**: Single source of truth for page type behavior
- **Extensibility**: Adding new page type requires changes in only 2 files vs 31+
- **Type Safety**: Centralized TypeScript definitions improve type checking

### Developer Experience
- Clear documentation of page type capabilities
- Easier onboarding for new developers
- Reduced cognitive load when working with page types
- Simplified debugging with centralized logic

### Risk Mitigation
- Reduces bugs from inconsistent implementations
- Prevents feature drift between components
- Easier to audit and update security permissions
- Simplified testing with centralized logic

## Migration Checklist

- [ ] Create configuration files in `/packages/lib`
- [ ] Create unified icon component
- [ ] Update TreeNode.tsx icon logic (lines 92-106)
- [ ] Update drive/Icon.tsx (lines 20-35)
- [ ] Update folder/Icon.tsx (lines 19-32)
- [ ] Update PermissionsGrid.tsx icon logic (lines 82-91)
- [ ] Refactor middle-content/index.tsx component selection (lines 39-54)
- [ ] Refactor CenterPanel.tsx component selection (lines 64-78)
- [ ] Update CreatePageDialog.tsx content initialization (lines 91-98)
- [ ] Update useLayoutStore.ts type mapping (lines 81-89)
- [ ] Update API route validations
- [ ] Update AI tool descriptions
- [ ] Add comprehensive tests
- [ ] Update documentation
- [ ] Performance testing
- [ ] Deploy to staging
- [ ] Monitor for issues
- [ ] Deploy to production

## Notes for Developers

1. **Icon Inconsistency**: PermissionsGrid uses `Bot` icon for AI_CHAT while others use `Sparkles`
2. **Missing Cases**: folder/Icon.tsx missing FILE type handling
3. **Breaking Changes**: This refactoring should be backward compatible if implemented carefully
4. **Testing Priority**: Focus on page creation, type switching, and icon display
5. **Performance**: The centralized config should be imported statically to avoid runtime overhead
6. **Future Types**: New page types should be added to the config first, then components
7. **Database**: The enum in the database schema must stay synchronized with the TypeScript enum

---

*Document updated: 2024-12-31*
*Analysis verified with codebase-researcher agent*
*Based on codebase state at commit: c954a97 with recent TreeNode.tsx modifications*
