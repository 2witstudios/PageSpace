import { createId, isCuid } from '@paralleldrive/cuid2';

/**
 * Resolves the id to persist a client-originated message under. A
 * client-supplied id is honored ONLY when it is a well-formed cuid — the
 * scoped upsert (`saveMessageToDatabase`/`saveGlobalAssistantMessageToDatabase`)
 * reasons about a colliding id as "another row in a different conversation";
 * an arbitrary, non-cuid string is a different failure mode (unvalidated
 * input reaching a primary key) that this closes off at the enqueue boundary
 * instead. Mints a fresh id for an absent OR malformed client id, matching
 * the pre-existing `userMessage.id || createId()` fallback for the absent case.
 */
export const resolveMessageId = (clientId: string | undefined | null): string =>
  clientId && isCuid(clientId) ? clientId : createId();
