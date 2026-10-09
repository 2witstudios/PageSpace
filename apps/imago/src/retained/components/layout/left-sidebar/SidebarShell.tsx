"use client";
import type { ReactNode } from 'react';
import { cn } from '@/retained/lib/utils';
/** The Imago rail already owns primary navigation and drive/account controls. */
export default function SidebarShell({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex h-full min-h-0 flex-col overflow-hidden', className)}>{children}</div>;
}
