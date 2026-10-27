/**
 * The listening-ports list, shared by the pane picker (where it is the way a
 * pane BECOMES a preview) and the ports pane's header (where it is the way to
 * diagnose one). One copy of the rows so the words are the same in both.
 *
 * Presentational: the host decides when to probe and what a pick does; this
 * renders a listing and reports the click. Two rules carried from the pane:
 * PICKING IS CONSENT — so the audience is stated beside the choice, before
 * it is made — and THE SENTENCE COMES FROM THE SERVER for every refusal.
 */

'use client';

import { ApiRequestError } from '@/lib/auth/auth-fetch';
import type { DevPreviewProbedPort } from '@pagespace/lib/services/sandbox/preview/dev-preview-status';
import { NOTHING_LISTENING } from './dev-preview-copy';

export interface PortsListing {
  spriteInstanceId: string;
  ports: DevPreviewProbedPort[];
  currentPort: number | null;
}

/** The server's sentence, or a neutral one — never a stack trace, never silence. */
export function messageOf(error: unknown, fallback: string): string {
  if (error instanceof ApiRequestError && error.message.trim() !== '') return error.message;
  if (error instanceof Error && error.message.trim() !== '') return error.message;
  return fallback;
}

/** Why a row is (not) pickable — the tooltip, and the trailing text for an ignored row. */
export function describeProbedPort(entry: DevPreviewProbedPort): string {
  if (entry.kind === 'ignored') {
    return entry.reason === 'non-http-service-port' ? 'Looks like a database or service port, not a web server'
      : entry.reason === 'relay-own-listener' ? 'The preview relay itself'
      : 'Cannot be previewed';
  }
  return entry.likelihood === 'known-dev-port' ? 'Looks like a dev server' : 'Unlisted port';
}

export function PortsList({
  listing,
  audience,
  canOpen,
  picking,
  disabled,
  onPick,
}: {
  listing: PortsListing;
  /** WHO can reach the preview once a port is picked — null when unknown (never invented). */
  audience: string | null;
  /** Whether the current port is actually serving — decides "Previewing" vs "Selected". */
  canOpen: boolean;
  /** The port whose pick is in flight, if any. */
  picking: number | null;
  /** Every row disabled — the host has no authority to pick, or a pick is in flight. */
  disabled: boolean;
  onPick(port: number, spriteInstanceId: string): void;
}) {
  if (listing.ports.length === 0) {
    return <p className="text-xs text-muted-foreground" data-testid="ports-list">{NOTHING_LISTENING}</p>;
  }
  return (
    <div role="radiogroup" aria-label="Listening ports" className="flex flex-col gap-1 text-xs" data-testid="ports-list">
      {audience && <p className="pb-1 text-muted-foreground">{audience}</p>}
      {listing.ports.map((entry) => {
        const why = describeProbedPort(entry);
        return (
          <button
            key={entry.port}
            type="button"
            role="radio"
            aria-checked={entry.current}
            disabled={disabled || entry.kind === 'ignored' || picking !== null}
            onClick={() => onPick(entry.port, listing.spriteInstanceId)}
            className="flex items-center justify-between rounded px-2 py-1 text-left hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
            title={why}
            data-testid={`ports-pick-${entry.port}`}
          >
            <span className="font-mono">:{entry.port}{entry.pid !== null ? <span className="ml-2 text-muted-foreground">pid {entry.pid}</span> : null}</span>
            <span className="text-muted-foreground">
              {picking === entry.port ? 'Starting…'
                // `current` is the persisted TARGET; whether it is actually
                // serving is the status's `canOpen`. A pick whose relay could
                // not start (a stranger on 8080) is selected, not previewing.
                : entry.current ? (canOpen ? 'Previewing' : 'Selected')
                : entry.kind === 'ignored' ? why
                : 'Preview this' + (listing.currentPort !== null ? ' instead' : '')}
            </span>
          </button>
        );
      })}
    </div>
  );
}
