import React from 'react';
import {
  FileText,
  FileCheck,
  Folder,
  MessageSquare,
  Sparkles,
  Palette,
  FileIcon,
  Table,
  CheckSquare
} from 'lucide-react';
import { PageType, getPageTypeIconName } from '@pagespace/lib/client-safe';

interface PageTypeIconProps {
  type: PageType;
  className?: string;
  isTaskLinked?: boolean;
}

// Map icon names to actual icon components
const iconMap = {
  Folder,
  FileText,
  FileCheck,
  MessageSquare,
  Sparkles,
  Palette,
  FileIcon,
  Table,
  CheckSquare,
} as const;

export function PageTypeIcon({ type, className, isTaskLinked }: PageTypeIconProps) {
  const iconName = getPageTypeIconName(type);

  // Use FileCheck icon for task-linked documents
  if (type === 'DOCUMENT' && isTaskLinked) {
    return <FileCheck className={className} />;
  }

  const Icon = iconMap[iconName as keyof typeof iconMap] || FileText;

  return <Icon className={className} />;
}