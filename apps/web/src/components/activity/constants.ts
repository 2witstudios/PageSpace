import {
  Activity,
  Bot,
  FileText,
  FolderOpen,
  Move,
  Pencil,
  Plus,
  RotateCcw,
  Settings,
  Shield,
  Trash2,
} from 'lucide-react';
import type { OperationConfig } from './types';

export const operationConfig: Record<string, OperationConfig> = {
  create: { icon: Plus, label: 'Created', variant: 'default' },
  update: { icon: Pencil, label: 'Updated', variant: 'secondary' },
  delete: { icon: Trash2, label: 'Deleted', variant: 'destructive' },
  restore: { icon: RotateCcw, label: 'Restored', variant: 'outline' },
  reorder: { icon: Move, label: 'Reordered', variant: 'secondary' },
  trash: { icon: Trash2, label: 'Trashed', variant: 'destructive' },
  move: { icon: Move, label: 'Moved', variant: 'secondary' },
  permission_grant: { icon: Shield, label: 'Permission Granted', variant: 'default' },
  permission_update: { icon: Shield, label: 'Permission Updated', variant: 'secondary' },
  permission_revoke: { icon: Shield, label: 'Permission Revoked', variant: 'destructive' },
  agent_config_update: { icon: Settings, label: 'Agent Updated', variant: 'secondary' },
};

export const resourceTypeIcons: Record<string, typeof FileText> = {
  page: FileText,
  drive: FolderOpen,
  permission: Shield,
  agent: Bot,
};

export const defaultOperationConfig: OperationConfig = {
  icon: Activity,
  label: 'Unknown',
  variant: 'secondary',
};
