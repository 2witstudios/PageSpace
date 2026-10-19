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
import { useImagoPageId } from '@/ui/chat/use-chat-data/use-chat-data';
import { ImagoOrb } from '@/ui/metal/imago-orb/imago-orb';

interface PageTypeIconProps {
  type: PageType;
  className?: string;
  isTaskLinked?: boolean;
  /** The page's id: Imago's own agent page is drawn as Imago's orb (Imago maintained edit). */
  pageId?: string;
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

/** An agent page's icon: Imago's own page is its orb, still until hovered. */
function AgentPageIcon({ pageId, className }: { pageId: string; className?: string }) {
  const imago = useImagoPageId() === pageId;
  return imago ? <ImagoOrb size="glyph" className={className} /> : <BotMessageSquare className={className} />;
}

export function PageTypeIcon({ type, className, isTaskLinked, pageId }: PageTypeIconProps) {
  if (type === 'AI_CHAT' && pageId !== undefined) return <AgentPageIcon pageId={pageId} className={className} />;
  const iconName = getPageTypeIconName(type);

  if (type === 'DOCUMENT' && isTaskLinked) {
    return <FileCheck2 className={className} />;
  }

  const Icon = iconMap[iconName as keyof typeof iconMap] || FileText;

  return <Icon className={className} />;
}
