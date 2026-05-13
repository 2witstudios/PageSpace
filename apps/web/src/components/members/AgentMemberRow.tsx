'use client';

import { useState } from 'react';
import { Bot, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select';
import { getRoleColorClasses } from '@/lib/utils';
import { patch, del } from '@/lib/auth/auth-fetch';
import { useToast } from '@/hooks/useToast';

export interface AgentMember {
  id: string;
  agentPageId: string;
  title: string | null;
  role: string;
  addedAt: Date | string;
  customRole: { id: string; name: string; color: string | null } | null;
}

interface DriveRole {
  id: string;
  name: string;
  color?: string | null;
}

interface AgentMemberRowProps {
  agent: AgentMember;
  driveId: string;
  currentUserRole: 'OWNER' | 'ADMIN' | 'MEMBER';
  driveRoles: DriveRole[];
  onRoleChange: (agentPageId: string, updated: Partial<AgentMember>) => void;
  onRemove: (agentPageId: string) => void;
}

function getRoleBadge(agent: AgentMember) {
  if (agent.role === 'ADMIN') {
    return (
      <Badge className="bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300">
        Admin
      </Badge>
    );
  }
  if (agent.customRole) {
    return (
      <Badge className={getRoleColorClasses(agent.customRole.color ?? undefined)}>
        {agent.customRole.name}
      </Badge>
    );
  }
  return (
    <Badge className="bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300">
      Member
    </Badge>
  );
}

function currentSelectValue(agent: AgentMember): string {
  if (agent.role === 'ADMIN') return 'ADMIN';
  if (agent.customRole) return agent.customRole.id;
  return 'MEMBER';
}

export function AgentMemberRow({
  agent,
  driveId,
  currentUserRole,
  driveRoles,
  onRoleChange,
  onRemove,
}: AgentMemberRowProps) {
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const canManage = currentUserRole === 'OWNER' || currentUserRole === 'ADMIN';
  const displayName = agent.title ?? 'Unnamed Agent';

  const handleRoleSelect = async (value: string) => {
    setSaving(true);
    try {
      let body: { role?: 'MEMBER' | 'ADMIN'; customRoleId?: string | null };
      if (value === 'ADMIN') {
        body = { role: 'ADMIN', customRoleId: null };
      } else if (value === 'MEMBER') {
        body = { role: 'MEMBER', customRoleId: null };
      } else {
        body = { role: 'MEMBER', customRoleId: value };
      }

      await patch(`/api/drives/${driveId}/agents/${agent.agentPageId}`, body);

      const customRole = value !== 'ADMIN' && value !== 'MEMBER'
        ? (driveRoles.find((r) => r.id === value) ?? null)
        : null;

      onRoleChange(agent.agentPageId, {
        role: body.role ?? agent.role,
        customRole: customRole ? { id: customRole.id, name: customRole.name, color: customRole.color ?? null } : null,
      });
    } catch {
      toast({ title: 'Error', description: 'Failed to update agent role', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    if (!confirm(`Remove ${displayName} from drive members?`)) return;
    try {
      await del(`/api/drives/${driveId}/agents/${agent.agentPageId}`);
      onRemove(agent.agentPageId);
    } catch {
      toast({ title: 'Error', description: 'Failed to remove agent member', variant: 'destructive' });
    }
  };

  return (
    <div className="p-4 flex items-center justify-between hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
      <div className="flex items-center space-x-4">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
          <Bot className="h-5 w-5 text-muted-foreground" />
        </div>
        <div>
          <div className="flex items-center space-x-2">
            <p className="font-medium">{displayName}</p>
            {!canManage && getRoleBadge(agent)}
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400">AI Agent</p>
        </div>
      </div>

      <div className="flex items-center space-x-2">
        {canManage ? (
          <Select
            value={currentSelectValue(agent)}
            onValueChange={handleRoleSelect}
            disabled={saving}
          >
            <SelectTrigger className="w-36 h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ADMIN">Admin</SelectItem>
              <SelectItem value="MEMBER">Member</SelectItem>
              {driveRoles.length > 0 && (
                <>
                  <SelectSeparator />
                  {driveRoles.map((role) => (
                    <SelectItem key={role.id} value={role.id}>
                      <span className="flex items-center gap-2">
                        {role.color && (
                          <span
                            className="inline-block h-2 w-2 rounded-full"
                            style={{ backgroundColor: role.color.startsWith('#') ? role.color : undefined }}
                          />
                        )}
                        {role.name}
                      </span>
                    </SelectItem>
                  ))}
                </>
              )}
            </SelectContent>
          </Select>
        ) : (
          getRoleBadge(agent)
        )}

        {canManage && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleRemove}
            className="text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
            title="Remove Agent Member"
          >
            <Trash2 className="w-4 h-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
