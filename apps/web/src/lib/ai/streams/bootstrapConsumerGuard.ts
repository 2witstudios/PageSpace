// Guards against two co-mounted useChannelStreamSocket instances both SSE-joining the same bootstrapped stream.
const activeConsumers = new Set<string>();

export function claimBootstrapConsumer(messageId: string): boolean {
  if (activeConsumers.has(messageId)) return false;
  activeConsumers.add(messageId);
  return true;
}

export function releaseBootstrapConsumer(messageId: string): void {
  activeConsumers.delete(messageId);
}
