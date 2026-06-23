'use client';

import { useRouter } from 'next/navigation';
import { FileText, Hash, CheckSquare, MessageSquare, Folder, Sparkles, Table, Code, File } from 'lucide-react';
import type { LinkPreviewData } from '@/hooks/useLinkPreview';

export function getPageTypeLabel(type: string): string {
  switch (type) {
    case 'DOCUMENT': return 'Document';
    case 'CHANNEL': return 'Channel';
    case 'TASK_LIST': return 'Task List';
    case 'AI_CHAT': return 'AI Chat';
    case 'FOLDER': return 'Folder';
    case 'CANVAS': return 'Canvas';
    case 'SHEET': return 'Sheet';
    case 'CODE': return 'Code';
    case 'FILE': return 'File';
    default: return type;
  }
}

export function buildPreviewHref(preview: LinkPreviewData): string {
  return `/dashboard/${preview.driveId}/${preview.id}`;
}

export function getPreviewSubtext(preview: LinkPreviewData): string | undefined {
  if (preview.type === 'DOCUMENT' && preview.snippet) return preview.snippet;
  if (preview.type === 'CHANNEL' && preview.memberCount !== undefined) {
    return `${preview.memberCount} members`;
  }
  if (preview.type === 'TASK_LIST' && preview.taskCount !== undefined) {
    return `${preview.taskCount} tasks`;
  }
  return undefined;
}

function PageTypeIcon({ type }: { type: string }) {
  const cls = 'h-4 w-4 shrink-0 text-muted-foreground';
  switch (type) {
    case 'DOCUMENT': return <FileText className={cls} />;
    case 'CHANNEL': return <Hash className={cls} />;
    case 'TASK_LIST': return <CheckSquare className={cls} />;
    case 'AI_CHAT': return <MessageSquare className={cls} />;
    case 'FOLDER': return <Folder className={cls} />;
    case 'CANVAS': return <Sparkles className={cls} />;
    case 'SHEET': return <Table className={cls} />;
    case 'CODE': return <Code className={cls} />;
    case 'FILE': return <File className={cls} />;
    default: return <FileText className={cls} />;
  }
}

interface PageLinkPreviewProps {
  preview: LinkPreviewData;
}

export function PageLinkPreview({ preview }: PageLinkPreviewProps) {
  const router = useRouter();
  const subtext = getPreviewSubtext(preview);

  return (
    <div
      role="link"
      tabIndex={0}
      className="mt-1 flex cursor-pointer items-start gap-3 rounded-md border p-3 hover:bg-muted"
      onClick={() => router.push(buildPreviewHref(preview))}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          router.push(buildPreviewHref(preview));
        } else if (e.key === ' ') {
          e.preventDefault();
          router.push(buildPreviewHref(preview));
        }
      }}
    >
      <PageTypeIcon type={preview.type} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{preview.title}</span>
          <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
            {getPageTypeLabel(preview.type)}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">{preview.driveName}</p>
        {subtext && (
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{subtext}</p>
        )}
      </div>
    </div>
  );
}
