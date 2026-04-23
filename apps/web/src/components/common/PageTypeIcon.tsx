import React from 'react';
import {
  File,
  FileCheck2,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  Folder,
  BotMessageSquare,
  MessagesSquare,
  SquareCheckBig,
  SquareTerminal,
} from 'lucide-react';
import { PageType, getPageTypeIconName } from '@pagespace/lib/client-safe';

interface PageTypeIconProps {
  type: PageType;
  className?: string;
  isTaskLinked?: boolean;
}

const iconMap = {
  Folder,
  FileText,
  FileCheck2,
  FileCode,
  FileImage,
  FileSpreadsheet,
  File,
  MessagesSquare,
  BotMessageSquare,
  SquareTerminal,
} as const;

export function PageTypeIcon({ type, className, isTaskLinked }: PageTypeIconProps) {
  const iconName = getPageTypeIconName(type);

  if (type === 'DOCUMENT' && isTaskLinked) {
    return <SquareCheckBig className={className} />;
  }

  const Icon = iconMap[iconName as keyof typeof iconMap] || FileText;

  return <Icon className={className} />;
}
