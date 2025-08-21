/**
 * Agent Role Dropdown Component
 * 
 * A compact dropdown selector for AI agent roles, designed for use in
 * space-constrained areas like sidebars. Provides clear labeling and
 * descriptions for each role while maintaining a minimal footprint.
 */

import React from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { AgentRole, ROLE_METADATA } from '@/lib/ai/agent-roles';
import { ToolPermissionFilter } from '@/lib/ai/tool-permissions';

interface AgentRoleDropdownProps {
  currentRole: AgentRole;
  onRoleChange: (role: AgentRole) => void;
  disabled?: boolean;
  className?: string;
}

export function AgentRoleDropdown({
  currentRole,
  onRoleChange,
  disabled = false,
  className = ''
}: AgentRoleDropdownProps) {
  const handleValueChange = (value: string) => {
    if (Object.values(AgentRole).includes(value as AgentRole)) {
      onRoleChange(value as AgentRole);
    }
  };

  return (
    <Select
      value={currentRole}
      onValueChange={handleValueChange}
      disabled={disabled}
    >
      <SelectTrigger className={`w-full ${className}`}>
        <SelectValue placeholder="Select agent mode">
          <div className="flex items-center gap-2">
            <span className="font-medium">{ROLE_METADATA[currentRole].label}</span>
            <span className="text-xs text-muted-foreground hidden sm:inline">
              Mode
            </span>
          </div>
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {Object.values(AgentRole).map((role) => {
          const metadata = ROLE_METADATA[role];
          const toolsSummary = ToolPermissionFilter.getToolsSummary(role);
          
          return (
            <SelectItem key={role} value={role} className="cursor-pointer">
              <div className="flex flex-col gap-1 py-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{metadata.label}</span>
                  <span className="text-xs text-muted-foreground">
                    ({toolsSummary.allowed} tools)
                  </span>
                </div>
                <span className="text-xs text-muted-foreground">
                  {metadata.shortDescription}
                </span>
              </div>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

/**
 * Compact variant for very tight spaces
 */
export function AgentRoleDropdownCompact({
  currentRole,
  onRoleChange,
  disabled = false,
}: Omit<AgentRoleDropdownProps, 'className'>) {
  const handleValueChange = (value: string) => {
    if (Object.values(AgentRole).includes(value as AgentRole)) {
      onRoleChange(value as AgentRole);
    }
  };

  return (
    <Select
      value={currentRole}
      onValueChange={handleValueChange}
      disabled={disabled}
    >
      <SelectTrigger className="h-8 text-xs">
        <SelectValue>
          {ROLE_METADATA[currentRole].label}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {Object.values(AgentRole).map((role) => {
          const metadata = ROLE_METADATA[role];
          
          return (
            <SelectItem key={role} value={role} className="text-xs">
              <div className="flex items-center gap-2">
                <span>{metadata.label}</span>
              </div>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}