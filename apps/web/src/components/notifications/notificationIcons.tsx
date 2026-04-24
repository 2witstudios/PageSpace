import type { LucideIcon } from 'lucide-react';
import {
  AtSign,
  FileText,
  ListTodo,
  Mail,
  MessageCircle,
  Share2,
  Shield,
  UserCheck,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import type { NotificationType } from '@pagespace/lib/notifications/types';

export const NOTIFICATION_ICONS: Record<NotificationType, LucideIcon> = {
  PERMISSION_GRANTED: Share2,
  PERMISSION_UPDATED: Shield,
  PERMISSION_REVOKED: X,
  PAGE_SHARED: Share2,
  DRIVE_INVITED: UserPlus,
  DRIVE_JOINED: Users,
  DRIVE_ROLE_CHANGED: Users,
  CONNECTION_REQUEST: UserPlus,
  CONNECTION_ACCEPTED: UserCheck,
  CONNECTION_REJECTED: X,
  NEW_DIRECT_MESSAGE: MessageCircle,
  EMAIL_VERIFICATION_REQUIRED: Mail,
  TOS_PRIVACY_UPDATED: FileText,
  MENTION: AtSign,
  TASK_ASSIGNED: ListTodo,
};

export function getNotificationIcon(type: string): LucideIcon {
  return NOTIFICATION_ICONS[type as NotificationType] ?? FileText;
}
