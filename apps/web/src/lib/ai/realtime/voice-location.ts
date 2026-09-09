/**
 * The app's `LocationContext` narrowed to the shape the voice bridge accepts.
 *
 * Two types describe the same idea and are NOT assignable to each other: the
 * chat surfaces' `LocationContext` uses `T | null` for an absent page or drive
 * (`chat-types.ts`), while `voiceLocationContextSchema` — which the realtime
 * server parses with, and which rejects what it does not recognise — uses
 * `.optional()`. A `null` handed straight through is a live call whose tools
 * lose their sense of place at the first zod parse, and the failure surfaces as
 * the model answering "this page" wrongly rather than as an error.
 *
 * So the conversion is written down once, here, instead of at each call site
 * where it would be re-derived slightly differently.
 *
 * `undefined` out means "nowhere in particular" — a route with no page and no
 * drive. That is a legitimate answer (the settings screen, a notification
 * list), not an error, and the session treats it as "leave the tools' location
 * unset" rather than inventing one.
 *
 * Pure: no I/O, no clock, no randomness, no module-level mutable state.
 */

import type { LocationContext } from '@/lib/ai/shared/chat-types';
import type { VoiceLocationContext } from '@pagespace/lib/realtime/voice-bridge-contract';

export const toVoiceLocationContext = (
  location: LocationContext | null | undefined,
): VoiceLocationContext | undefined => {
  if (!location) return undefined;

  const currentPage = location.currentPage ?? undefined;
  const currentDrive = location.currentDrive ?? undefined;
  const breadcrumbs = location.breadcrumbs;

  // Nothing recognisable to send. An empty object would still parse, but it
  // would overwrite a location the call already had with an empty one.
  if (!currentPage && !currentDrive && (!breadcrumbs || breadcrumbs.length === 0)) {
    return undefined;
  }

  return {
    ...(currentPage === undefined
      ? {}
      : {
          currentPage: {
            id: currentPage.id,
            title: currentPage.title,
            type: currentPage.type,
            path: currentPage.path,
            ...(currentPage.isTaskLinked === undefined
              ? {}
              : { isTaskLinked: currentPage.isTaskLinked }),
          },
        }),
    ...(currentDrive === undefined
      ? {}
      : {
          currentDrive: {
            id: currentDrive.id,
            name: currentDrive.name,
            slug: currentDrive.slug,
          },
        }),
    ...(breadcrumbs === undefined || breadcrumbs.length === 0 ? {} : { breadcrumbs }),
  };
};
