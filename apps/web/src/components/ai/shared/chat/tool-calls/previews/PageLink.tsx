"use client";

import React from 'react';
import Link from 'next/link';
import { ExternalLink } from 'lucide-react';
import { PageTypeIcon } from '@/components/common/PageTypeIcon';
import { cn } from '@/lib/utils';
import type { PageType } from '@pagespace/lib/client-safe';

interface PageLinkProps {
  pageId: string;
  driveId: string;
  title: string;
  type?: PageType;
  isTaskLinked?: boolean;
  className?: string;
}

export const PageLink: React.FC<PageLinkProps> = ({
  pageId,
  driveId,
  title,
  type = 'DOCUMENT',
  isTaskLinked,
  className
}) => {
  const href = `/dashboard/${driveId}/${pageId}`;

  return (
    <Link
      href={href}
      className={cn(
        "inline-flex items-center gap-2 text-sm text-primary hover:underline",
        className
      )}
      title={`Open "${title}"`}
    >
      <PageTypeIcon type={type} className="h-4 w-4" isTaskLinked={isTaskLinked} />
      <span className="truncate max-w-[200px]">{title}</span>
      <ExternalLink className="h-3 w-3 text-muted-foreground" />
    </Link>
  );
};
