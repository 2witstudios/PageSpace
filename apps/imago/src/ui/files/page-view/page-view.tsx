'use client';

import type { ReactNode } from 'react';
import { renderObjectPlaceholder } from '../../frame/shell/object-placeholder';
import { type DocumentPage } from '../document-view/document-view';
import { usePage } from '../page-object/page-object';
import type { TreePage } from '@/retained/hooks/usePageTree';
import { RetainedSurface } from '@/retained-adapters/retained-provider';
import { AgentPage } from '../page-types/agent-page';
import { CanvasPage } from '../page-types/canvas-page';
import { ChannelPage } from '../page-types/channel-page';
import { CodePage } from '../page-types/code-page';
import { DocumentPage as DocumentPageView } from '../page-types/document-page';
import { FilePage } from '../page-types/file-page';
import { SheetPage } from '../page-types/sheet-page';
import { TaskListPage } from '../page-types/task-list-page';

export type PageViewProps = {
  readonly driveId: string;
  readonly pageId: string;
};

/** The page as a document the view can draw, or null for any other page type. */
export const documentOf = (data: unknown): DocumentPage | null => {
  if (typeof data !== 'object' || data === null) return null;
  const { id, title, type, content, revision, contentMode } = data as Record<string, unknown>;
  if (type !== 'DOCUMENT' || typeof id !== 'string') return null;
  return {
    id,
    title: typeof title === 'string' ? title : '',
    content: typeof content === 'string' ? content : '',
    revision: typeof revision === 'number' ? revision : 0,
    contentMode: contentMode === 'markdown' ? 'markdown' : 'html',
  };
};

/** Dispatch the permission-filtered page into a reused native object view. */
export function PageView({ driveId, pageId }: PageViewProps): ReactNode {
  const { data } = usePage(pageId);
  if (!data || typeof data !== 'object' || !('type' in data)) return renderObjectPlaceholder('Page');
  const page = data as TreePage;
  const props = { page, driveId, pageId };
  // One module per page type (ui/files/page-types): each owns its 44px strip (IMC-1.10) and body,
  // under the page head (IMC-1.9), which is the page's only header.
  let content: ReactNode;
  switch (page.type) {
    case 'DOCUMENT': content = <DocumentPageView {...props} />; break;
    case 'CODE': content = <CodePage {...props} />; break;
    case 'SHEET': content = <SheetPage {...props} />; break;
    case 'CANVAS': content = <CanvasPage {...props} />; break;
    case 'FILE': content = <FilePage {...props} />; break;
    case 'CHANNEL': content = <ChannelPage {...props} />; break;
    case 'TASK_LIST': content = <TaskListPage {...props} />; break;
    case 'AI_CHAT': content = <AgentPage {...props} />; break;
    default: return renderObjectPlaceholder('Page');
  }
  return <RetainedSurface><div className="h-full min-h-0">{content}</div></RetainedSurface>;
}
