/**
 * MCP Tool Converter for Web Package
 * Re-exports from @pagespace/lib for backward compatibility
 */

// Re-export all MCP tool converter functions from the shared package
export {
  validateToolName,
  validateServerName,
  createSafeToolName,
  convertMCPToolSchemaToZod,
  convertMCPToolsToAISDKSchemas,
  parseMCPToolName,
  isMCPTool,
  type MCPToolConversionOptions,
} from '@pagespace/lib';

// Re-export types
export type { MCPTool, ToolExecutionResult } from '@pagespace/lib';
