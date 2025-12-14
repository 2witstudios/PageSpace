/**
 * MCPToggle - Toggle component for MCP (Model Context Protocol) integration
 * Used in chat headers to enable/disable MCP tools per conversation
 */

import React from 'react';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Server } from 'lucide-react';

interface MCPToggleProps {
  /** Whether we're running in desktop app */
  isDesktop: boolean;
  /** Whether MCP is enabled for this conversation */
  mcpEnabled: boolean;
  /** Number of running MCP servers */
  runningServers: number;
  /** Callback when toggle state changes */
  onToggle: (enabled: boolean) => void;
  /** Optional className for styling */
  className?: string;
}

/**
 * MCP Toggle component for chat headers
 * Only renders when in desktop app mode
 */
export const MCPToggle: React.FC<MCPToggleProps> = ({
  isDesktop,
  mcpEnabled,
  runningServers,
  onToggle,
  className,
}) => {
  // Only show in desktop app
  if (!isDesktop) return null;

  return (
    <div
      className={`flex items-center gap-2 border border-[var(--separator)] rounded-lg px-3 py-1.5 ${className || ''}`}
    >
      <Server className="h-4 w-4 text-muted-foreground" />
      <span className="text-sm text-muted-foreground hidden md:inline">MCP</span>
      {runningServers > 0 && mcpEnabled && (
        <Badge variant="default" className="h-5 text-xs">
          {runningServers}
        </Badge>
      )}
      <Switch
        checked={mcpEnabled}
        onCheckedChange={onToggle}
        disabled={runningServers === 0}
        aria-label="Enable/disable MCP tools for this conversation"
        className="scale-75 md:scale-100"
      />
    </div>
  );
};
