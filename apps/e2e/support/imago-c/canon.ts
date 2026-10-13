/**
 * The CANON story data the Imago C v3 boards draw (PageSpace page g6lkehiixpit8fbujl1ecqxw),
 * as plain data for the imago-c specs' seed. Fixtures and e2e only: the product renders real
 * API data, so nothing in apps/imago reads this.
 */
import type { PageTypeValue } from '@pagespace/lib/utils/enums';

export type CanonNode = {
  readonly title: string;
  readonly type: PageTypeValue;
  readonly children?: readonly CanonNode[];
};

/** The Files tree, identical on every Files board. */
export const CANON_TREE: readonly CanonNode[] = [
  {
    title: 'Launch',
    type: 'FOLDER',
    children: [
      { title: 'Q4 Launch Plan', type: 'DOCUMENT' },
      { title: 'Launch Tasks', type: 'TASK_LIST' },
      { title: 'Pricing Model', type: 'SHEET' },
      { title: 'Waitlist Page', type: 'CANVAS' },
      { title: 'Waitlist Signups', type: 'SHEET' },
      { title: 'pricing-calc.ts', type: 'CODE' },
      { title: 'launch-ops', type: 'CHANNEL' },
      { title: 'Launch Agent', type: 'AI_CHAT' },
    ],
  },
  {
    title: 'Research',
    type: 'FOLDER',
    children: [
      { title: 'Research Plan', type: 'DOCUMENT' },
      { title: 'Interviews', type: 'FOLDER' },
      { title: 'Interview — Priya.pdf', type: 'FILE' },
      { title: 'Competitor Notes', type: 'DOCUMENT' },
      { title: 'Research Agent', type: 'AI_CHAT' },
    ],
  },
  { title: 'Brand Voice', type: 'DOCUMENT' },
  { title: 'Onboarding Notes', type: 'DOCUMENT' },
  { title: 'Hiring', type: 'FOLDER' },
  { title: 'Inbox Triage', type: 'AI_CHAT' },
];

/** Favorites at the top of the Files pane. */
export const CANON_FAVORITES: readonly string[] = ['Q4 Launch Plan', 'Launch Tasks'];

/** Recents with how long ago each was viewed ("now", "1h", "2h"). */
export const CANON_RECENTS: readonly { readonly title: string; readonly minutesAgo: number }[] = [
  { title: 'Q4 Launch Plan', minutesAgo: 0 },
  { title: 'Pricing Model', minutesAgo: 60 },
  { title: 'launch-ops', minutesAgo: 120 },
];

/** The open tabs every page board shows, in order. */
export const CANON_TABS: readonly string[] = ['Q4 Launch Plan', 'Pricing Model', 'launch-ops'];

export type FlatCanonNode = CanonNode & { readonly parent: string | null; readonly depth: number };

/** The tree in display order, each node with its parent's title. */
export const flattenCanon = (
  nodes: readonly CanonNode[],
  parent: string | null = null,
  depth = 0,
): readonly FlatCanonNode[] =>
  nodes.flatMap((node) => [
    { ...node, parent, depth },
    ...flattenCanon(node.children ?? [], node.title, depth + 1),
  ]);
