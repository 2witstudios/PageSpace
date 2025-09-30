/**
 * Role Selector Component for AI Agent Roles
 * 
 * Allows users to switch between PARTNER, PLANNER, and WRITER modes
 * with clear visual indicators and capability descriptions.
 */

import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { 
  Tooltip, 
  TooltipContent, 
  TooltipProvider, 
  TooltipTrigger 
} from '@/components/ui/tooltip';
import { 
  Card, 
  CardContent, 
  CardDescription, 
  CardHeader, 
  CardTitle 
} from '@/components/ui/card';
import { 
  Dialog, 
  DialogContent, 
  DialogDescription, 
  DialogHeader, 
  DialogTitle, 
  DialogTrigger 
} from '@/components/ui/dialog';
import { Info } from 'lucide-react';
import { AgentRole, ROLE_METADATA } from '@/lib/ai/agent-roles';
import { ToolPermissionFilter } from '@/lib/ai/tool-permissions';

interface RoleSelectorProps {
  currentRole: AgentRole;
  onRoleChange: (role: AgentRole) => void;
  disabled?: boolean;
  showLabels?: boolean;
  size?: 'sm' | 'md' | 'lg';
  variant?: 'compact' | 'detailed';
}

export function RoleSelector({
  currentRole,
  onRoleChange,
  disabled = false,
  showLabels = true,
  size = 'md',
  variant = 'compact'
}: RoleSelectorProps) {
  const [showDetails, setShowDetails] = useState(false);

  const getRoleButtonVariant = (role: AgentRole) => {
    return currentRole === role ? 'default' : 'ghost';
  };


  const getButtonSize = () => {
    switch (size) {
      case 'sm':
        return 'sm';
      case 'lg':
        return 'lg';
      default:
        return 'sm';
    }
  };

  if (variant === 'detailed') {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">AI Agent Mode</h3>
          <Dialog open={showDetails} onOpenChange={setShowDetails}>
            <DialogTrigger asChild>
              <Button variant="ghost" size="sm">
                <Info className="h-4 w-4" />
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl">
              <DialogHeader>
                <DialogTitle>AI Agent Roles</DialogTitle>
                <DialogDescription>
                  Choose the right mode for your task. Each role has different capabilities and behaviors.
                </DialogDescription>
              </DialogHeader>
              <RoleDetailsCards currentRole={currentRole} onRoleSelect={onRoleChange} />
            </DialogContent>
          </Dialog>
        </div>
        
        <div className="grid grid-cols-3 gap-2">
          {Object.values(AgentRole).map((role) => {
            const metadata = ROLE_METADATA[role];
            const capability = ToolPermissionFilter.getRoleCapabilityDescription(role);
            
            return (
              <TooltipProvider key={role}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant={getRoleButtonVariant(role)}
                      size={getButtonSize()}
                      onClick={() => onRoleChange(role)}
                      disabled={disabled}
                      className="flex flex-col h-auto py-3 px-2 text-center"
                    >
                      <div className="flex items-center space-x-1 mb-1">
                        {metadata.icon && <span className="text-lg">{metadata.icon}</span>}
                        {showLabels && (
                          <span className="text-xs font-medium">{metadata.label}</span>
                        )}
                      </div>
                      <span className="text-xs text-muted-foreground line-clamp-2">
                        {metadata.shortDescription}
                      </span>
                      {currentRole === role && (
                        <Badge variant="secondary" className="mt-1 text-xs">
                          Active
                        </Badge>
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-xs !bg-gray-900 !text-white dark:!bg-gray-100 dark:!text-gray-900">
                    <div className="space-y-1">
                      <p className="font-medium">{metadata.label} Mode</p>
                      <p className="text-sm">{capability}</p>
                    </div>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            );
          })}
        </div>
        
        <div className="text-xs text-muted-foreground">
          Current: {ROLE_METADATA[currentRole].shortDescription}
        </div>
      </div>
    );
  }

  // Compact variant (default)
  return (
    <div className="flex items-center space-x-1 p-1 bg-muted rounded-lg">
      {Object.values(AgentRole).map((role) => {
        const metadata = ROLE_METADATA[role];
        
        return (
          <TooltipProvider key={role}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={getRoleButtonVariant(role)}
                  size={getButtonSize()}
                  onClick={() => onRoleChange(role)}
                  disabled={disabled}
                  className="flex items-center space-x-1"
                >
                  {metadata.icon && <span>{metadata.icon}</span>}
                  {showLabels && (
                    <span className="text-xs">{metadata.label}</span>
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent className="!bg-gray-900 !text-white dark:!bg-gray-100 dark:!text-gray-900">
                <div className="space-y-1">
                  <p className="font-medium">{metadata.label} Mode</p>
                  <p className="text-sm">{metadata.shortDescription}</p>
                </div>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        );
      })}
    </div>
  );
}

/**
 * Detailed role cards for the dialog
 */
function RoleDetailsCards({ 
  currentRole, 
  onRoleSelect 
}: { 
  currentRole: AgentRole; 
  onRoleSelect: (role: AgentRole) => void; 
}) {
  return (
    <div className="grid gap-4">
      {Object.values(AgentRole).map((role) => {
        const metadata = ROLE_METADATA[role];
        const capability = ToolPermissionFilter.getRoleCapabilityDescription(role);
        const summary = ToolPermissionFilter.getToolsSummary(role);
        const isActive = currentRole === role;
        
        return (
          <Card 
            key={role} 
            className={`cursor-pointer transition-all ${
              isActive ? 'ring-2 ring-primary' : 'hover:shadow-md'
            }`}
            onClick={() => onRoleSelect(role)}
          >
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center space-x-2">
                  {metadata.icon && <span className="text-2xl">{metadata.icon}</span>}
                  <span>{metadata.label}</span>
                  {isActive && (
                    <Badge variant="default">Current</Badge>
                  )}
                </CardTitle>
                <Badge variant="outline">
                  {summary.allowed}/{summary.total} tools
                </Badge>
              </div>
              <CardDescription>{metadata.shortDescription}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <h4 className="text-sm font-medium mb-1">Primary Use Case</h4>
                <p className="text-sm text-muted-foreground">{metadata.primaryUseCase}</p>
              </div>
              
              <div>
                <h4 className="text-sm font-medium mb-1">Capabilities</h4>
                <p className="text-sm text-muted-foreground">{capability}</p>
              </div>
              
              <div>
                <h4 className="text-sm font-medium mb-1">Workflow</h4>
                <ul className="text-sm text-muted-foreground space-y-1">
                  {metadata.workflow.map((step, index) => (
                    <li key={index} className="flex items-start space-x-1">
                      <span className="text-xs text-muted-foreground mt-1">•</span>
                      <span>{step}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

/**
 * Role status indicator - shows current role with minimal UI
 */
export function RoleStatusIndicator({ 
  role, 
  showDescription = false 
}: { 
  role: AgentRole; 
  showDescription?: boolean; 
}) {
  const metadata = ROLE_METADATA[role];
  
  return (
    <div className="flex items-center space-x-2">
      <div className="flex items-center space-x-1">
        {metadata.icon && <span className="text-sm">{metadata.icon}</span>}
        <span className="text-sm font-medium">{metadata.label}</span>
      </div>
      {showDescription && (
        <span className="text-xs text-muted-foreground">
          {metadata.shortDescription}
        </span>
      )}
    </div>
  );
}

/**
 * Role transition notification
 */
export function RoleTransitionNotification({ 
  fromRole, 
  toRole, 
  onDismiss 
}: { 
  fromRole: AgentRole; 
  toRole: AgentRole; 
  onDismiss: () => void; 
}) {
  const fromMeta = ROLE_METADATA[fromRole];
  const toMeta = ROLE_METADATA[toRole];
  
  return (
    <div className="flex items-center justify-between p-3 bg-primary/10 dark:bg-primary/20 border border-primary/20 dark:border-primary/30 rounded-lg">
      <div className="flex items-center space-x-2">
        <div className="flex items-center space-x-1">
          {fromMeta.icon && <span>{fromMeta.icon}</span>}
          <span className="text-sm line-through text-muted-foreground">{fromMeta.label}</span>
        </div>
        <span className="text-sm text-muted-foreground">→</span>
        <div className="flex items-center space-x-1">
          {toMeta.icon && <span>{toMeta.icon}</span>}
          <span className="text-sm font-medium">{toMeta.label}</span>
        </div>
      </div>
      <Button variant="ghost" size="sm" onClick={onDismiss}>
        ×
      </Button>
    </div>
  );
}