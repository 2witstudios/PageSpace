import type { ListSection } from '../frame/stage/stage';

/**
 * Scalar shell state (drafts, filters, expansion, the open conversation).
 * Section leaves add their fields here as they land.
 */
export type UiResources = {
  /** Sections whose list the viewer hid; the stage itself lives in the URL. */
  readonly collapsedSections: readonly ListSection[];
};

/**
 * Entity lists the shell renders (files, conversations, tasks). Real data
 * from later leaves fills these; there is no mock seed.
 */
export type UiCollections = Readonly<Record<never, never>>;

export type UiState = {
  readonly resources: UiResources;
  readonly collections: UiCollections;
};

/** The empty shell: the swap point for real data from later leaves. */
export const createInitialState = (): UiState => ({
  resources: { collapsedSections: [] },
  collections: {},
});
