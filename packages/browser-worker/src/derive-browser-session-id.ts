export type BrowserSessionCoordinates = {
  readonly tenantId: string;
  readonly ownerId: string;
  readonly agentId: string;
  readonly conversationId: string;
};

export const deriveBrowserSessionId = (_coordinates: BrowserSessionCoordinates): string => {
  throw new Error('deriveBrowserSessionId: not implemented (RED)');
};
