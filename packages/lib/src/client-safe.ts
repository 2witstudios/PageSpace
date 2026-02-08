/**
 * Client-Safe Exports for @pagespace/lib
 *
 * This module contains only browser-compatible exports with no Node.js dependencies.
 * It's safe to import from client-side React components.
 */

// Enums (always safe for client-side)
export * from './utils/enums';

// Client-safe types (no server dependencies)
export * from './types';

// Browser-safe utilities
export * from './utils/utils';
export * from './content/tree-utils';

// Page type configurations (safe - no server dependencies)
export * from './content/page-types.config';
export * from './content/page-type-validators';

// Sheet utilities (safe - pure JavaScript functions)
export * from './sheets';

// Page content parsing (safe - no server dependencies)
export * from './content/page-content-parser';

// Browser-safe format/parse bytes utilities
export { formatBytes, parseBytes } from './utils/format';

// Client-safe notification types and guards (no database dependencies)
export * from './notifications/types';
export * from './notifications/guards';

// Note: Server-side modules like permissions, auth-utils, logger-config, etc.
// are NOT exported here to prevent Node.js dependencies in browser bundles.
