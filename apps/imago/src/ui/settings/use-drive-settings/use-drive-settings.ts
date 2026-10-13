'use client';

// What the drive settings object reads and writes: the drive, its members and
// the viewer's Imago access, each one apps/web route in the shared SWR cache.
//
// A write shows at once, is sent through the imago client (session and CSRF),
// rolls back if the server refuses (a 403 for a role lost since the page
// loaded, a Home-drive guard, a 409 from the toggle), and says why. The
// server's answer is the state afterwards; the client holds no policy of its
// own beyond hiding what the server would refuse anyway.

import { useCallback } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { useApiClient } from '@/api/swr-provider';
import { ApiError } from '@/api/errors';
import { DRIVES } from '../../frame/drives/drives';
import {
  driveActions,
  driveEndpoint,
  driveOf,
  imagoAccessEndpoint,
  imagoAccessOf,
  membersEndpoint,
  membersFrom,
  type DriveActions,
  type DriveSettings,
  type ImagoAccess,
  type Member,
} from '../settings-model/settings-model';

export type WriteResult = { readonly ok: true } | { readonly ok: false; readonly refusal: string };

const OFFLINE = 'Could not reach PageSpace';

const refusalOf = (error: unknown): string => (error instanceof ApiError ? error.message : OFFLINE);

const withName = (body: unknown, name: string): unknown =>
  typeof body === 'object' && body !== null ? { ...body, name } : body;

export type DriveSettingsData = {
  readonly drive: DriveSettings | undefined;
  readonly driveError: unknown;
  readonly retryDrive: () => void;
  readonly actions: DriveActions | null;
  readonly members: readonly Member[] | undefined;
  readonly membersError: unknown;
  readonly retryMembers: () => void;
  /** Undefined while loading, and when the viewer may not manage it (no request is made). */
  readonly access: ImagoAccess | undefined;
  readonly accessError: unknown;
  readonly retryAccess: () => void;
  readonly rename: (name: string) => Promise<WriteResult>;
  readonly setImagoAccess: (enabled: boolean) => Promise<WriteResult>;
};

export function useDriveSettings(driveId: string): DriveSettingsData {
  const client = useApiClient();
  const { mutate: mutateKey } = useSWRConfig();
  const driveKey = driveEndpoint(driveId);
  const accessKey = imagoAccessEndpoint(driveId);

  const driveQuery = useSWR<unknown>(driveKey);
  const membersQuery = useSWR<unknown>(membersEndpoint(driveId));
  const drive = driveQuery.data === undefined ? undefined : driveOf(driveQuery.data) ?? undefined;
  const actions = drive === undefined ? null : driveActions(drive);
  // The route answers 403 to anyone who may not manage it: only they ask.
  const accessQuery = useSWR<unknown>(actions?.imagoAccess === true ? accessKey : null);

  const { mutate: mutateDrive } = driveQuery;
  const { mutate: mutateAccess } = accessQuery;

  const rename = useCallback(
    async (name: string): Promise<WriteResult> => {
      let result: WriteResult = { ok: true };
      try {
        await mutateDrive(
          async (current: unknown) => {
            await client.apiFetch(driveKey, { method: 'PATCH', json: { name } });
            return current;
          },
          {
            optimisticData: (current: unknown) => withName(current, name),
            rollbackOnError: true,
            populateCache: false,
            revalidate: false,
          },
        );
      } catch (error) {
        result = { ok: false, refusal: refusalOf(error) };
      }
      // Saved or refused, the server has the last word, here and in the drive list.
      await Promise.all([mutateDrive(), mutateKey(DRIVES)]);
      return result;
    },
    [client, driveKey, mutateDrive, mutateKey],
  );

  const setImagoAccess = useCallback(
    async (enabled: boolean): Promise<WriteResult> => {
      try {
        await mutateAccess(() => client.apiFetch<unknown>(accessKey, { method: 'PUT', json: { enabled } }), {
          optimisticData: (current: unknown) =>
            typeof current === 'object' && current !== null ? { ...current, enabled } : { enabled },
          rollbackOnError: true,
          populateCache: true,
          revalidate: false,
        });
        return { ok: true };
      } catch (error) {
        return { ok: false, refusal: refusalOf(error) };
      }
    },
    [accessKey, client, mutateAccess],
  );

  const retryDrive = useCallback(() => void mutateDrive(), [mutateDrive]);
  const retryMembers = useCallback(() => void membersQuery.mutate(), [membersQuery]);
  const retryAccess = useCallback(() => void mutateAccess(), [mutateAccess]);

  return {
    drive,
    // A body that is not a drive is as unusable as a failed request.
    driveError:
      (driveQuery.error as unknown) ??
      (driveQuery.data !== undefined && drive === undefined ? new Error('Not a drive') : undefined),
    retryDrive,
    actions,
    members: membersQuery.data === undefined ? undefined : membersFrom(membersQuery.data) ?? undefined,
    membersError: membersQuery.error as unknown,
    retryMembers,
    access: accessQuery.data === undefined ? undefined : imagoAccessOf(accessQuery.data) ?? undefined,
    accessError: accessQuery.error as unknown,
    retryAccess,
    rename,
    setImagoAccess,
  };
}
