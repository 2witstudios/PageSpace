import { create } from 'zustand';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';

/** Author-supplied SEO/appearance overrides for a published page. */
export interface PublishSettingsSnapshot {
  title: string;
  description: string;
  ogImageUrl: string;
  noindex: boolean;
  /** Canvas pages only — see published_pages.themeBridgeEnabled. */
  themeBridgeEnabled: boolean;
}

export interface PublishStatus {
  published: boolean;
  // Whether the current viewer can edit this page (vs. view-only access).
  // A view-only viewer can still get `published: true` and a real
  // `settings.themeBridgeEnabled` (the GET route serves that much to any
  // viewer — see the route's view-permission comment), but every editing
  // surface (Save buttons, toggles) must also check this: `published` alone
  // does NOT mean "safe to show editable, savable fields".
  canEdit: boolean;
  url: string | null;
  // Whether the server can publish at all (dedicated public bucket configured).
  available: boolean;
  isStale: boolean;
  // True only for a transient failure to load status (network error, 5xx) —
  // distinct from `!available`, which means the status request succeeded (or
  // definitively 403'd for a read-only viewer) and reported publishing as
  // genuinely unavailable.
  hasLoadError: boolean;
  settings: PublishSettingsSnapshot;
}

export const EMPTY_PUBLISH_SETTINGS: PublishSettingsSnapshot = {
  title: '',
  description: '',
  ogImageUrl: '',
  noindex: false,
  themeBridgeEnabled: true,
};

export const EMPTY_PUBLISH_STATUS: PublishStatus = {
  published: false,
  canEdit: false,
  url: null,
  available: false,
  isStale: false,
  hasLoadError: false,
  settings: EMPTY_PUBLISH_SETTINGS,
};

interface PublishStatusResponse {
  published: boolean;
  canEdit?: boolean;
  url?: string;
  available?: boolean;
  isStale?: boolean;
  title?: string | null;
  description?: string | null;
  ogImageUrl?: string | null;
  noindex?: boolean;
  themeBridgeEnabled?: boolean;
}

export const publishStatusFromResponse = (data: PublishStatusResponse): PublishStatus => ({
  published: data.published,
  // Fails closed: an absent `canEdit` (an older/unexpected response shape)
  // is treated as view-only rather than assumed editable.
  canEdit: data.canEdit ?? false,
  url: data.published ? data.url ?? null : null,
  available: data.available ?? false,
  isStale: data.isStale ?? false,
  hasLoadError: false,
  settings: {
    title: data.title ?? '',
    description: data.description ?? '',
    ogImageUrl: data.ogImageUrl ?? '',
    noindex: data.noindex ?? false,
    themeBridgeEnabled: data.themeBridgeEnabled ?? true,
  },
});

interface PublishStatusStoreState {
  /** Keyed by pageId. Shared so every surface showing a page's publish state
   *  (the header's PublishControls, the canvas Settings tab's Publish and
   *  Appearance categories, the View tab's live preview) stays in sync —
   *  publishing/unpublishing from one immediately reflects in the others,
   *  instead of each independently fetching once on mount and going stale. */
  statuses: Map<string, PublishStatus>;
  inFlight: Map<string, Promise<void>>;
  // Bumped on every `setStatus` call (a mutation's result, or a fetch's own
  // applied result) AND captured by `fetchStatus` before it starts its
  // network call. Lets an in-flight fetch detect it's been superseded —
  // see `fetchStatus`'s comment for the race this closes.
  generations: Map<string, number>;
  setStatus: (pageId: string, status: PublishStatus) => void;
  /** Fetches and caches this page's publish status. Concurrent calls for the
   *  same pageId (e.g. the header and the canvas Settings tab mounting at
   *  once) share one in-flight request instead of firing duplicates. */
  fetchStatus: (pageId: string) => Promise<void>;
}

export const usePublishStatusStore = create<PublishStatusStoreState>((set, get) => ({
  statuses: new Map(),
  inFlight: new Map(),
  generations: new Map(),

  setStatus: (pageId, status) => {
    // Bump first: any fetchStatus call already in flight for this pageId
    // captured an older generation number and will now see a mismatch when
    // it resolves, so it discards its (potentially stale) result instead of
    // overwriting this write — this is itself a legitimate, authoritative
    // write (a mutation's result, or a fetch's own already-current result),
    // not one being superseded.
    const nextGen = (get().generations.get(pageId) ?? 0) + 1;
    const nextGenerations = new Map(get().generations);
    nextGenerations.set(pageId, nextGen);
    const next = new Map(get().statuses);
    next.set(pageId, status);
    set({ statuses: next, generations: nextGenerations });
  },

  fetchStatus: (pageId) => {
    const existing = get().inFlight.get(pageId);
    if (existing) return existing;

    // On a transient failure (network error, 5xx), keep whatever was last
    // known good rather than wiping it to EMPTY_PUBLISH_STATUS — every
    // shared consumer (the header, both Settings categories) reads the same
    // entry, so re-entering a category and hitting a blip would otherwise
    // make the header's controls disappear and re-disable already-published
    // settings until something else happens to trigger a successful refetch.
    // A 403 is different: it's a definitive "no permission" signal, not a
    // failure, so it's safe (and correct) to reset to the empty state.
    const keepLastGoodOnFailure = (): PublishStatus => {
      const prev = get().statuses.get(pageId);
      return prev ? { ...prev, hasLoadError: true } : { ...EMPTY_PUBLISH_STATUS, hasLoadError: true };
    };

    // Claim the current generation before the network round-trip starts. If
    // a mutation (publish/unpublish/save/toggle) commits its own setStatus
    // while this fetch is still in flight, the generation bumps past
    // `myGen` — this fetch's eventual response is then a stale read of a row
    // a newer, authoritative write has already superseded (e.g. it read the
    // page as published just before an Unpublish click, and would otherwise
    // resurrect that state — including the header's Copy Link URL — right
    // after the unpublish succeeded).
    const myGen = (get().generations.get(pageId) ?? 0) + 1;
    {
      const nextGenerations = new Map(get().generations);
      nextGenerations.set(pageId, myGen);
      set({ generations: nextGenerations });
    }
    const isSuperseded = () => get().generations.get(pageId) !== myGen;

    const promise = (async () => {
      try {
        const res = await fetchWithAuth(`/api/pages/${pageId}/publish`);
        if (res.ok) {
          const data = (await res.json()) as PublishStatusResponse;
          if (!isSuperseded()) get().setStatus(pageId, publishStatusFromResponse(data));
        } else if (res.status === 403) {
          if (!isSuperseded()) get().setStatus(pageId, { ...EMPTY_PUBLISH_STATUS, hasLoadError: false });
        } else {
          if (!isSuperseded()) get().setStatus(pageId, keepLastGoodOnFailure());
        }
      } catch {
        if (!isSuperseded()) get().setStatus(pageId, keepLastGoodOnFailure());
      } finally {
        const nextInFlight = new Map(get().inFlight);
        nextInFlight.delete(pageId);
        set({ inFlight: nextInFlight });
      }
    })();

    set({ inFlight: new Map(get().inFlight).set(pageId, promise) });
    return promise;
  },
}));
