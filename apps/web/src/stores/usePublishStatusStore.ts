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
  url: null,
  available: false,
  isStale: false,
  hasLoadError: false,
  settings: EMPTY_PUBLISH_SETTINGS,
};

interface PublishStatusResponse {
  published: boolean;
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
  setStatus: (pageId: string, status: PublishStatus) => void;
  /** Fetches and caches this page's publish status. Concurrent calls for the
   *  same pageId (e.g. the header and the canvas Settings tab mounting at
   *  once) share one in-flight request instead of firing duplicates. */
  fetchStatus: (pageId: string) => Promise<void>;
}

export const usePublishStatusStore = create<PublishStatusStoreState>((set, get) => ({
  statuses: new Map(),
  inFlight: new Map(),

  setStatus: (pageId, status) => {
    const next = new Map(get().statuses);
    next.set(pageId, status);
    set({ statuses: next });
  },

  fetchStatus: (pageId) => {
    const existing = get().inFlight.get(pageId);
    if (existing) return existing;

    const promise = (async () => {
      try {
        const res = await fetchWithAuth(`/api/pages/${pageId}/publish`);
        const status = res.ok
          ? publishStatusFromResponse((await res.json()) as PublishStatusResponse)
          : { ...EMPTY_PUBLISH_STATUS, hasLoadError: res.status !== 403 };
        get().setStatus(pageId, status);
      } catch {
        get().setStatus(pageId, { ...EMPTY_PUBLISH_STATUS, hasLoadError: true });
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
