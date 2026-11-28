// What a member's page-permission edits amount to, for the dirty bar (C-Members-Profile:
// "2 permission changes on Pricing Model and launch-ops"). A page with no row counts as all off.

export type PagePermissions = { readonly canView: boolean; readonly canEdit: boolean; readonly canShare: boolean };

export type PermissionChange = { readonly pageId: string; readonly title: string };

const OFF: PagePermissions = { canView: false, canEdit: false, canShare: false };

const same = (a: PagePermissions | undefined, b: PagePermissions | undefined): boolean => {
  const left = a ?? OFF;
  const right = b ?? OFF;
  return left.canView === right.canView && left.canEdit === right.canEdit && left.canShare === right.canShare;
};

/** The pages whose access differs from the saved access, ordered by page id. */
export function changedPages(
  saved: ReadonlyMap<string, PagePermissions>,
  current: ReadonlyMap<string, PagePermissions>,
  titles: ReadonlyMap<string, string>,
): readonly PermissionChange[] {
  const ids = new Set([...saved.keys(), ...current.keys()]);
  return [...ids]
    .filter((pageId) => !same(saved.get(pageId), current.get(pageId)))
    .map((pageId) => ({ pageId, title: titles.get(pageId) ?? 'a page' }));
}

/** "1 permission change on X", "2 permission changes on X and Y", "3 permission changes on X, Y and 1 more". */
export function describeChanges(changes: readonly PermissionChange[]): string {
  const count = changes.length;
  const names = changes.map((change) => change.title);
  const listed =
    names.length <= 2 ? names.join(' and ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
  return `${count} permission change${count === 1 ? '' : 's'} on ${listed}`;
}

/** Flattens a page tree into id -> title, so the changes can be named. */
export function pageTitlesOf(
  nodes: readonly { readonly id: string; readonly title: string; readonly children?: readonly unknown[] }[],
): ReadonlyMap<string, string> {
  const titles = new Map<string, string>();
  const visit = (list: readonly { readonly id: string; readonly title: string; readonly children?: readonly unknown[] }[]) => {
    for (const node of list) {
      titles.set(node.id, node.title);
      if (node.children) visit(node.children as typeof list);
    }
  };
  visit(nodes);
  return titles;
}
