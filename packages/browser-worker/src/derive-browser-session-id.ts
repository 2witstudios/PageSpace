/**
 * The id of the one browser session a (tenant, owner, agent, conversation)
 * gets — pure and deterministic, so any web instance finds the same session
 * (and, on Sprites, the same Sprite name) without shared state. The fields
 * are hashed as a JSON array, so no concatenation of two fields can collide
 * with another pair. A different agent, owner or conversation is a different
 * browser: principals never share a profile.
 */
import { createHash } from 'node:crypto';

export type BrowserSessionCoordinates = {
  readonly tenantId: string;
  readonly ownerId: string;
  readonly agentId: string;
  readonly conversationId: string;
};

const ID_HEX_LENGTH = 40;

export const deriveBrowserSessionId = ({ tenantId, ownerId, agentId, conversationId }: BrowserSessionCoordinates): string =>
  `bws_${createHash('sha256')
    .update(JSON.stringify(['browser-session:v1', tenantId, ownerId, agentId, conversationId]))
    .digest('hex')
    .slice(0, ID_HEX_LENGTH)}`;
