/** RED stub — real whoami SDK call lands in GREEN. */
import { z } from 'zod';
import { defineOperation } from '@pagespace/sdk';
import type { ConfirmIdentity } from './loopback-flow.js';

const meOutputSchema = z.object({
  name: z.string().nullable(),
  email: z.string(),
});

export const whoamiOperation = defineOperation({
  name: 'auth.me',
  method: 'GET',
  path: '/api/auth/me',
  inputSchema: z.object({}),
  outputSchema: meOutputSchema,
  requiredScope: 'account',
  description: "Confirm the authenticated user's identity (name/email).",
});

export const confirmIdentity: ConfirmIdentity = async () => {
  throw new Error('not implemented');
};
