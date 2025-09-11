import {
  FileText,
  Folder as FolderIcon,
  MessageSquare,
  Sparkles,
  FileIcon,
} from 'lucide-react';
import { PageType } from '@pagespace/lib/client';

interface IconProps {
  type: PageType;
  className?: string;
}

export function Icon({ type, className }: IconProps) {
  const IconComponent = getIconComponent(type);
  return <IconComponent className={className} />;
}

function getIconComponent(type: PageType) {
  switch (type) {
    case PageType.FOLDER:
      return FolderIcon;
    case PageType.DOCUMENT:
      return FileText;
    case PageType.CHANNEL:
      return MessageSquare;
    case PageType.AI_CHAT:
      return Sparkles;
    case PageType.FILE:
      return FileIcon;
    default:
      return FileText;
  }
}