'use client';

import { useCallback } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { stageFor, toolViewSegment, type DriveTool } from '../stage/stage';

/**
 * A tool's own screen, the object its pane opens (stage.ts): `/view`, or Members' `/all`.
 * The tool's bare address is its pane beside the chat.
 */
export const toolScreenHref = (driveId: string, tool: DriveTool, search = ''): string =>
  `/${encodeURIComponent(driveId)}/${tool}/${tool === 'members' ? 'all' : toolViewSegment}${search}`;

export type ToolScreen = {
  /** Whether the tool's screen is already open beside the pane. */
  readonly onScreen: boolean;
  /**
   * Opens the screen with this query: from the pane alone it pushes the screen (so Back
   * returns to the pane), and on the screen it replaces the query in place.
   */
  readonly open: (search: string) => void;
};

export function useToolScreen(driveId: string, tool: DriveTool): ToolScreen {
  const pathname = usePathname() ?? '/';
  const router = useRouter();
  const onScreen = stageFor(pathname).object !== null;
  const open = useCallback(
    (search: string) => {
      if (onScreen) router.replace(`${pathname}${search}`, { scroll: false });
      else router.push(toolScreenHref(driveId, tool, search), { scroll: false });
    },
    [driveId, onScreen, pathname, router, tool],
  );
  return { onScreen, open };
}
