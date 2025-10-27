import {
  experimental_createMCPClient,
  Experimental_StdioMCPTransport,
} from 'ai';
import { ChildProcess } from 'child_process';

/**
 * MCP Bridge - Connects to MCP servers and fetches available tools
 *
 * This bridge runs in the Electron main process and:
 * 1. Creates MCP clients for running servers
 * 2. Fetches tool definitions from each server
 * 3. Exposes tools via IPC to renderer process
 * 4. Handles tool execution by proxying calls to MCP servers
 */

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
  serverName: string;
}

interface MCPClient {
  client: any;
  tools: Record<string, any>;
  serverName: string;
}

export class MCPBridge {
  private clients: Map<string, MCPClient> = new Map();

  /**
   * Connect to an MCP server and fetch its tools
   */
  async connectToServer(
    serverName: string,
    process: ChildProcess
  ): Promise<void> {
    try {
      // We can't directly create an MCP client from an existing process
      // because the AI SDK expects to spawn its own process.
      // Instead, we'll need to expose tool definitions via a different mechanism.

      console.log(`MCP Bridge: Skipping connection to ${serverName} - process already spawned`);

      // TODO: Implement proper MCP client integration
      // For now, we'll just track that the server is running
      // In a full implementation, we would:
      // 1. Communicate with the MCP server via stdio
      // 2. Send MCP protocol messages to list tools
      // 3. Parse tool definitions
      // 4. Store them for use in AI chat

    } catch (error) {
      console.error(`Failed to connect to MCP server ${serverName}:`, error);
      throw error;
    }
  }

  /**
   * Disconnect from an MCP server
   */
  async disconnectFromServer(serverName: string): Promise<void> {
    const client = this.clients.get(serverName);
    if (client) {
      try {
        await client.client.close();
      } catch (error) {
        console.error(`Error closing MCP client for ${serverName}:`, error);
      }
      this.clients.delete(serverName);
    }
  }

  /**
   * Get all available tools from connected MCP servers
   */
  async getAllTools(): Promise<MCPTool[]> {
    const tools: MCPTool[] = [];

    for (const [serverName, client] of this.clients.entries()) {
      try {
        // Convert MCP tool format to our tool format
        for (const [toolName, toolDef] of Object.entries(client.tools)) {
          const tool = toolDef as any;
          tools.push({
            name: `mcp_${serverName}_${toolName}`,
            description: tool.description || `Tool from ${serverName}`,
            inputSchema: tool.inputSchema || { type: 'object', properties: {} },
            serverName,
          });
        }
      } catch (error) {
        console.error(`Error fetching tools from ${serverName}:`, error);
      }
    }

    return tools;
  }

  /**
   * Execute a tool on an MCP server
   */
  async executeTool(
    serverName: string,
    toolName: string,
    args: any
  ): Promise<any> {
    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(`No MCP client found for server: ${serverName}`);
    }

    try {
      // Execute the tool via the MCP client
      const tool = client.tools[toolName];
      if (!tool) {
        throw new Error(`Tool ${toolName} not found on server ${serverName}`);
      }

      // Call the tool
      const result = await tool.execute(args);
      return result;
    } catch (error) {
      console.error(`Error executing tool ${toolName} on ${serverName}:`, error);
      throw error;
    }
  }

  /**
   * Cleanup all clients
   */
  async cleanup(): Promise<void> {
    const closePromises: Promise<void>[] = [];

    for (const serverName of this.clients.keys()) {
      closePromises.push(this.disconnectFromServer(serverName));
    }

    await Promise.all(closePromises);
    this.clients.clear();
  }
}

// Singleton instance
let mcpBridge: MCPBridge | null = null;

/**
 * Get the MCP bridge singleton
 */
export function getMCPBridge(): MCPBridge {
  if (!mcpBridge) {
    mcpBridge = new MCPBridge();
  }
  return mcpBridge;
}
