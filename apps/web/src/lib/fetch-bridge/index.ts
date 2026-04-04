/**
 * @module @/lib/fetch-bridge
 * @description Desktop fetch bridge for routing HTTP requests through WebSocket
 *
 * STUB: This module provides the interface and singleton accessor for the FetchBridge.
 * The actual implementation is being built on a parallel branch (fetch-bridge-server).
 * These stubs ensure the integration layer compiles while the real implementation is merged.
 */

import type {
  FetchResponseStartMessage,
  FetchResponseChunkMessage,
  FetchResponseEndMessage,
  FetchResponseErrorMessage,
} from '@/lib/websocket/ws-message-schemas';

export interface FetchBridge {
  /** Handle the start of a fetch response — userId enables ownership validation */
  handleResponseStart(msg: FetchResponseStartMessage, userId: string): void;
  /** Handle a streamed body chunk — userId enables ownership validation */
  handleResponseChunk(msg: FetchResponseChunkMessage, userId: string): void;
  /** Handle the end of a fetch response stream — userId enables ownership validation */
  handleResponseEnd(msg: FetchResponseEndMessage, userId: string): void;
  /** Handle a fetch error — userId enables ownership validation */
  handleResponseError(msg: FetchResponseErrorMessage, userId: string): void;
  /** Cancel all pending fetch requests for a disconnected user */
  cancelUserRequests(userId: string): void;
  /** Check if a user has an active desktop bridge connection */
  isUserConnected(userId: string): boolean;
}

let fetchBridge: FetchBridge | null = null;

/**
 * Set the FetchBridge implementation (called by the real module on init)
 */
export function setFetchBridge(bridge: FetchBridge): void {
  fetchBridge = bridge;
}

/**
 * Get the FetchBridge singleton.
 * Returns the real implementation once the fetch-bridge-server branch is merged.
 */
export function getFetchBridge(): FetchBridge {
  if (!fetchBridge) {
    throw new Error(
      'FetchBridge not initialized — merge fetch-bridge-server branch for implementation'
    );
  }
  return fetchBridge;
}

/**
 * Check if the FetchBridge has been initialized.
 * Use this to safely check before calling getFetchBridge() in optional paths.
 */
export function isFetchBridgeInitialized(): boolean {
  return fetchBridge !== null;
}
