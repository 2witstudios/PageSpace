import {
  Activity, Bot, Building2, Coins, CreditCard, Folder, HardDrive, LogOut, Shield, SlidersHorizontal, Trash2, UserCheck, Users,
  type LucideIcon,
} from 'lucide-react';
import type { OrgHubIcon } from '@/retained/lib/orgs/org-hub';

export const ORG_HUB_ICONS: Record<OrgHubIcon, LucideIcon> = {
  guests: UserCheck,
  automation: Bot,
  general: Building2,
  members: Users,
  drives: Folder,
  policies: SlidersHorizontal,
  security: Shield,
  audit: Activity,
  plan: CreditCard,
  usage: Coins,
  backups: HardDrive,
  danger: Trash2,
  leave: LogOut,
};
