import type { PageTypeValue } from '@pagespace/lib/utils/enums';

/** The menu's title, as the board names it. */
export const pageActionsLabel = (title: string): string => `Page actions for ${title}`;

export const favoriteLabel = (isFavorite: boolean): string => (isFavorite ? 'Unfavorite' : 'Favorite');

export const protectLabel = (isPrivate: boolean): string => (isPrivate ? 'Unprotect page' : 'Protect page');

export const homePageLabel = (isHomePage: boolean): string =>
  isHomePage ? 'Remove as home page' : 'Set as home page';

/** The export formats a page type offers (apps/web's ExportDropdown, by type). */
export type ExportFormat = 'docx' | 'markdown' | 'csv' | 'xlsx';

export const exportFormatsFor = (pageType: PageTypeValue): readonly ExportFormat[] => {
  if (pageType === 'DOCUMENT') return ['docx', 'markdown'];
  if (pageType === 'SHEET') return ['csv', 'xlsx'];
  return [];
};

export const exportLabel = (format: ExportFormat): string =>
  ({ docx: 'Export as DOCX', markdown: 'Export as Markdown', csv: 'Export as CSV', xlsx: 'Export as Excel' })[format];

/** Dialogs the menu opens and the page's container owns (Rename, Share, Move/Copy, Trash…). */
export type PageActionDialog = 'add-child' | 'rename' | 'permissions' | 'move' | 'copy' | 'trash';

export type PageActionItem =
  | { readonly kind: 'open-new-tab'; readonly label: 'Open in new tab' }
  | { readonly kind: 'dialog'; readonly dialog: PageActionDialog; readonly label: string }
  | { readonly kind: 'favorite'; readonly label: string }
  | { readonly kind: 'protect'; readonly label: string }
  | { readonly kind: 'home-page'; readonly label: string }
  | { readonly kind: 'export'; readonly label: 'Export'; readonly formats: readonly ExportFormat[] }
  | { readonly kind: 'print'; readonly label: 'Print' }
  | { readonly kind: 'select-multiple'; readonly label: 'Select multiple' };

export type PageActionGroup = readonly PageActionItem[];

export type PageActionsState = {
  readonly pageType: PageTypeValue;
  readonly isFavorite: boolean;
  readonly isPrivate: boolean;
  readonly isHomePage: boolean;
  /** Owner or admin of the drive: only they set the drive's home page. */
  readonly canManageDrive: boolean;
  /** The Export and Print items join the menu (PAGE_ACTIONS_ABSORB_HEADER). */
  readonly absorbHeader: boolean;
};

/**
 * The page's actions, in the order PageTreeItem's context menu gives them, grouped by the
 * separators between them. Items the page type or the viewer does not have are left out.
 */
export const pageActionGroups = (state: PageActionsState): readonly PageActionGroup[] => {
  const exportFormats = exportFormatsFor(state.pageType);
  const navigation: PageActionItem[] = [
    { kind: 'open-new-tab', label: 'Open in new tab' },
    { kind: 'dialog', dialog: 'add-child', label: 'Add child page' },
    { kind: 'dialog', dialog: 'rename', label: 'Rename' },
    { kind: 'favorite', label: favoriteLabel(state.isFavorite) },
    { kind: 'protect', label: protectLabel(state.isPrivate) },
    { kind: 'dialog', dialog: 'permissions', label: 'Permissions' },
  ];
  if (state.canManageDrive) navigation.push({ kind: 'home-page', label: homePageLabel(state.isHomePage) });
  const absorbed: PageActionItem[] =
    state.absorbHeader && exportFormats.length > 0
      ? [{ kind: 'export', label: 'Export', formats: exportFormats }, { kind: 'print', label: 'Print' }]
      : [];
  const tree: PageActionItem[] = [
    { kind: 'select-multiple', label: 'Select multiple' },
    { kind: 'dialog', dialog: 'move', label: 'Move to...' },
    { kind: 'dialog', dialog: 'copy', label: 'Copy to...' },
  ];
  const trash: PageActionItem[] = [{ kind: 'dialog', dialog: 'trash', label: 'Trash' }];
  return [navigation, absorbed, tree, trash].filter((group) => group.length > 0);
};
