import { imagoHref } from '@/retained-adapters/navigation';
import { stageFor } from '@/ui/frame/stage/stage';
import { contextRefFor, type ContextRef } from '@/ui/chat/chat-context/context-ref';
import type { DriveEntry } from './resolveLocationContext';
export type { ContextRef };
export const buildContextRef = (pathname: string, _drives: DriveEntry[]): ContextRef => contextRefFor(stageFor(imagoHref(pathname)));
