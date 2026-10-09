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
import { PageType } from '@pagespace/lib/utils/enums';
import { getPageTypeIconName } from '@pagespace/lib/content/page-types.config';

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
  SquareCheckBig,
} as const;

export function PageTypeIcon({ type, className, isTaskLinked }: PageTypeIconProps) {
  const iconName = getPageTypeIconName(type);

  if (type === 'DOCUMENT' && isTaskLinked) {
    return <FileCheck2 className={className} />;
  }

  const Icon = iconMap[iconName as keyof typeof iconMap] || FileText;

  return <Icon className={className} />;
}
