import { imagoHref } from '@/retained-adapters/navigation';
import { stageFor } from '@/ui/frame/stage/stage';
import { contextRefFor, type ContextRef } from '@/ui/chat/chat-context/context-ref';
import type { SectionScopes } from '@/ui/frame/drives/section-scope';
export type { ContextRef };
export const buildContextRef = (pathname: string, homeDriveId: string | null, scopes?: SectionScopes): ContextRef =>
  contextRefFor(stageFor(imagoHref(pathname)), homeDriveId, scopes);
