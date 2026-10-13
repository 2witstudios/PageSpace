// GET /api/users/messageable (apps/web), read through imago's API client: the
// people the viewer may open a DM with, as the server answers them.

import type { ApiClient } from '@/api/client';
import { messageablePeopleFrom, type MessageablePerson, type MessageableUserResponse } from './dm-index-model';

export const messageablePath = '/api/users/messageable';

export const fetchMessageablePeople = async (client: ApiClient): Promise<readonly MessageablePerson[]> =>
  messageablePeopleFrom((await client.apiFetch<{ readonly users: readonly MessageableUserResponse[] }>(messageablePath)).users);
