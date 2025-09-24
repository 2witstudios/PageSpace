import React from 'react';
import {
  FileText,
  Folder,
  MessageSquare,
  Sparkles,
  Palette,
  FileIcon,
  Table
} from 'lucide-react';
import { PageType, getPageTypeIconName } from '@pagespace/lib';

interface PageTypeIconProps {
  type: PageType;
  className?: string;
}

// Map icon names to actual icon components
const iconMap = {
  Folder,
  FileText,
  MessageSquare,
  Sparkles,
  Palette,
  FileIcon,
  Table,
} as const;

export function PageTypeIcon({ type, className }: PageTypeIconProps) {
  const iconName = getPageTypeIconName(type);
  const Icon = iconMap[iconName as keyof typeof iconMap] || FileText;
  
  return <Icon className={className} />;
}