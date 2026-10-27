'use client';

import { Fragment, useState, type ReactNode } from 'react';
import Link from 'next/link';
import useSWR, { useSWRConfig } from 'swr';
import { toast } from 'sonner';
import { useApiClient } from '@/api/swr-provider';
import { RetainedSurface } from '@/retained-adapters/retained-provider';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/retained/components/ui/dropdown-menu';
import { useDriveStore } from '@/retained/hooks/useDrive';
import { useMultiSelectStore } from '@/retained/stores/useMultiSelectStore';
import { isPageTypeValue, type PageTypeValue } from '@pagespace/lib/utils/enums';
import { FAVORITES, favoritesOf } from '../favorites/favorites';
import { drivePageHref } from '../recents/recents';
import { pageKey, usePage } from '../page-object/page-object';
import { PAGE_ACTIONS_ABSORB_HEADER } from './page-actions-flag';
import { addFavorite, downloadExport, removeFavorite, setHomePage, setPageProtected } from './page-actions-api';
import {
  exportLabel,
  pageActionGroups,
  pageActionsLabel,
  type ExportFormat,
  type PageActionDialog,
  type PageActionItem,
} from './page-actions-model';

export type PageActionsMenuProps = {
  readonly driveId: string;
  readonly pageId: string;
  /** The control that opens the menu: one button element. */
  readonly trigger: ReactNode;
  /**
   * Void action: the page's container opens the dialog that owns an item (Rename, Share,
   * Move…). Without one, those items are not offered.
   */
  readonly onDialog?: (dialog: PageActionDialog) => void;
};

/** The page fields the menu needs from GET /api/pages/[pageId]; null until the page loads. */
export type MenuPage = {
  readonly title: string;
  readonly type: PageTypeValue;
  readonly isPrivate: boolean;
  readonly parentId: string | null;
};

export const menuPageOf = (body: unknown): MenuPage | null => {
  if (typeof body !== 'object' || body === null) return null;
  const { title, type, isPrivate, parentId } = body as Record<string, unknown>;
  if (typeof title !== 'string' || typeof type !== 'string' || !isPageTypeValue(type)) return null;
  return { title, type, isPrivate: isPrivate === true, parentId: typeof parentId === 'string' ? parentId : null };
};

/** A filename a browser can save: the title without what a filesystem refuses. */
export const exportStem = (title: string): string =>
  title.replace(/[^\p{L}\p{N} _-]+/gu, '').trim().replace(/\s+/g, '-').toLowerCase() || 'download';

const EXTENSION: Readonly<Record<ExportFormat, string>> = { docx: 'docx', markdown: 'md', csv: 'csv', xlsx: 'xlsx' };

/** The format's name without the "Export as " the menu item carries. */
const formatName = (format: ExportFormat): string => exportLabel(format).replace('Export as ', '');

/**
 * The page "…" menu, shared by the page head and a tree row's hover "…". Its data loads only
 * while it is open, so a tree of rows does not fetch once per row.
 */
export function PageActionsMenu({ driveId, pageId, trigger, onDialog }: PageActionsMenuProps) {
  const [open, setOpen] = useState(false);
  return (
    <RetainedSurface fill={false}>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
        {open ? <OpenPageActions driveId={driveId} pageId={pageId} onDialog={onDialog} /> : null}
      </DropdownMenu>
    </RetainedSurface>
  );
}

function OpenPageActions({ driveId, pageId, onDialog }: Pick<PageActionsMenuProps, 'driveId' | 'pageId' | 'onDialog'>) {
  const client = useApiClient();
  const { mutate } = useSWRConfig();
  const page = menuPageOf(usePage(pageId).data);
  const favorites = favoritesOf(useSWR<unknown>(FAVORITES).data, driveId);
  const drive = useDriveStore((state) => state.drives.find((candidate) => candidate.id === driveId));
  const updateDrive = useDriveStore((state) => state.updateDrive);
  const enterMultiSelect = useMultiSelectStore((state) => state.enterMultiSelectMode);
  const togglePage = useMultiSelectStore((state) => state.togglePageSelection);
  if (page === null) return null;

  const isFavorite = favorites.some((favorite) => favorite.id === pageId);
  const canManageDrive = drive !== undefined && (drive.isOwned || drive.role === 'ADMIN');
  const isHomePage = drive?.homePageId === pageId;
  const groups = pageActionGroups({
    pageType: page.type,
    isFavorite,
    isPrivate: page.isPrivate,
    isHomePage,
    canManageDrive,
    absorbHeader: PAGE_ACTIONS_ABSORB_HEADER,
  })
    .map((group) => group.filter((item) => item.kind !== 'dialog' || onDialog !== undefined))
    .filter((group) => group.length > 0);

  const toggleFavorite = async () => {
    const toastId = toast.loading(isFavorite ? 'Removing from favorites...' : 'Adding to favorites...');
    try {
      if (isFavorite) await removeFavorite(client, pageId);
      else await addFavorite(client, pageId);
      await mutate(FAVORITES);
      toast.success(isFavorite ? 'Page removed from favorites.' : 'Page added to favorites.', { id: toastId });
    } catch {
      toast.error('Error updating favorites.', { id: toastId });
    }
  };

  const toggleProtected = async () => {
    const nextPrivate = !page.isPrivate;
    const toastId = toast.loading(nextPrivate ? 'Protecting page...' : 'Unprotecting page...');
    try {
      await setPageProtected(client, pageId, nextPrivate);
      await mutate(pageKey(pageId));
      toast.success(nextPrivate ? 'Page is now private' : 'Page is now visible to all drive members', { id: toastId });
    } catch {
      toast.error('Error updating page privacy.', { id: toastId });
    }
  };

  const toggleHomePage = async () => {
    const next = isHomePage ? null : pageId;
    const toastId = toast.loading(next ? 'Setting home page...' : 'Removing home page...');
    try {
      await setHomePage(client, driveId, next);
      updateDrive(driveId, { homePageId: next });
      toast.success(next ? 'Home page set.' : 'Home page removed.', { id: toastId });
    } catch {
      toast.error('Error updating home page.', { id: toastId });
    }
  };

  const exportPage = async (format: ExportFormat) => {
    const toastId = toast.loading(`Exporting as ${formatName(format)}...`);
    try {
      await downloadExport(client, pageId, format, `${exportStem(page.title)}.${EXTENSION[format]}`);
      toast.success(`Exported as ${formatName(format)}`, { id: toastId });
    } catch {
      toast.error(`Failed to export as ${formatName(format)}`, { id: toastId });
    }
  };

  const selectMultiple = () => {
    enterMultiSelect(driveId);
    togglePage({ id: pageId, title: page.title, type: page.type, driveId, parentId: page.parentId });
  };

  /** The action a plain item runs; a link or submenu item is rendered on its own below. */
  const actionOf = (item: PageActionItem): (() => void) | undefined => {
    switch (item.kind) {
      case 'favorite':
        return () => void toggleFavorite();
      case 'protect':
        return () => void toggleProtected();
      case 'home-page':
        return () => void toggleHomePage();
      case 'dialog':
        return onDialog === undefined ? undefined : () => onDialog(item.dialog);
      case 'select-multiple':
        return selectMultiple;
      case 'print':
        return () => window.print();
      default:
        return undefined;
    }
  };

  const renderItem = (item: PageActionItem): ReactNode => {
    if (item.kind === 'open-new-tab') {
      return (
        <DropdownMenuItem key={item.kind} asChild>
          <Link href={drivePageHref(driveId, pageId)} target="_blank" rel="noopener">
            {item.label}
          </Link>
        </DropdownMenuItem>
      );
    }
    if (item.kind === 'export') {
      return (
        <DropdownMenuSub key={item.kind}>
          <DropdownMenuSubTrigger>{item.label}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent aria-label="Export">
            {item.formats.map((format) => (
              <DropdownMenuItem key={format} onSelect={() => void exportPage(format)}>
                {exportLabel(format)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      );
    }
    return (
      <DropdownMenuItem key={`${item.kind}-${item.label}`} onSelect={actionOf(item)}>
        {item.label}
      </DropdownMenuItem>
    );
  };

  return (
    // Radix names the menu after its trigger; the menu is named for the page instead.
    <DropdownMenuContent align="end" aria-label={pageActionsLabel(page.title)} aria-labelledby={undefined}>
      {groups.map((group, index) => (
        <Fragment key={index}>
          {index === 0 ? null : <DropdownMenuSeparator />}
          {group.map(renderItem)}
        </Fragment>
      ))}
    </DropdownMenuContent>
  );
}
