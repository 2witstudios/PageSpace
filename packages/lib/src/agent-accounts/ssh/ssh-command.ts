/**
 * SSH accounts (slice 5; ADR 0005 §10e): an account's one pinned host, and a
 * command as the canonical request both the authority and the plane digest.
 * Pure.
 *
 * - The TARGET is `ssh://host:port` (host lowercased; a DNS name or an IP
 *   literal; port 1–65535, default 22). It is the account's only "origin":
 *   the plane connects to nothing else, and only to a PUBLIC address it
 *   resolved itself.
 * - A COMMAND is canonicalized into the shared `CanonicalRequest` projection
 *   (channel `ssh-executor`, method `EXEC`, path `/exec`) whose body is the
 *   canonical JSON of `{ command, stdin }`. So the digest a person approves
 *   covers the exact command and input, the audit chain records their SHA-256
 *   — never the text — and approvals, policies, usage and the verifier work
 *   unchanged. Every command is the one operation `unknown/ssh.exec`: what a
 *   shell command does cannot be classed from its text, so it is never
 *   classed as a read.
 */
import type { CanonicalOrigin, CanonicalRequest } from '../canonical-request';
import type { HashBytes, OperationRef } from '../grant';
import { canonicalJson } from '../canonical-json';

export const SSH_OPERATION: OperationRef = { class: 'unknown', name: 'ssh.exec' };
export const MAX_SSH_COMMAND_BYTES = 8 * 1024;
export const MAX_SSH_STDIN_BYTES = 256 * 1024;
const DNS_NAME_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/;
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6_RE = /^[0-9a-f:]+$/;

export type SshTarget = { readonly target: CanonicalOrigin; readonly host: string; readonly port: number };

export function normalizeSshTarget({ host, port }: { readonly host: string; readonly port: number | null }): ({ readonly ok: true } & SshTarget) | { readonly ok: false; readonly reason: 'host_invalid' | 'port_invalid' } {
  const raw = typeof host === 'string' ? host.trim().toLowerCase().replace(/^\[|\]$/g, '') : '';
  const isV6 = raw.includes(':');
  if (raw.length === 0 || !(DNS_NAME_RE.test(raw) || IPV4_RE.test(raw) || (isV6 && IPV6_RE.test(raw)))) return { ok: false, reason: 'host_invalid' };
  const resolvedPort = port ?? 22;
  if (!Number.isInteger(resolvedPort) || resolvedPort < 1 || resolvedPort > 65_535) return { ok: false, reason: 'port_invalid' };
  const authority = isV6 ? `[${raw}]` : raw;
  return { ok: true, target: `ssh://${authority}:${resolvedPort}` as CanonicalOrigin, host: raw, port: resolvedPort };
}

/** The host and port an `ssh://` target names, or null for anything else. */
export function sshTargetOf(target: string): SshTarget | null {
  const match = /^ssh:\/\/(\[[0-9a-f:]+\]|[a-z0-9.-]+):(\d{1,5})$/.exec(target);
  if (match === null) return null;
  const verdict = normalizeSshTarget({ host: match[1]!, port: Number(match[2]) });
  return verdict.ok && verdict.target === target ? { target: verdict.target, host: verdict.host, port: verdict.port } : null;
}

/** The exact bytes the digest covers (and the plane runs): `{command, stdin}` as canonical JSON. */
export function sshCommandBody({ command, stdin }: { readonly command: string; readonly stdin: string }): Uint8Array {
  return new TextEncoder().encode(canonicalJson({ command, stdin }));
}

export type SshCommandVerdict = { readonly ok: true; readonly canonical: CanonicalRequest } | { readonly ok: false; readonly reason: 'target_invalid' | 'command_invalid' | 'stdin_too_large' };

export function canonicalizeSshCommand({ target, command, stdin, sha256 }: { readonly target: string; readonly command: string; readonly stdin: string; readonly sha256: HashBytes }): SshCommandVerdict {
  const pinned = sshTargetOf(target);
  if (pinned === null) return { ok: false, reason: 'target_invalid' };
  const encoder = new TextEncoder();
  if (typeof command !== 'string' || command.trim().length === 0 || encoder.encode(command).byteLength > MAX_SSH_COMMAND_BYTES || command.includes('\u0000')) return { ok: false, reason: 'command_invalid' };
  if (typeof stdin !== 'string' || encoder.encode(stdin).byteLength > MAX_SSH_STDIN_BYTES) return { ok: false, reason: 'stdin_too_large' };
  return {
    ok: true,
    canonical: {
      channel: 'ssh-executor',
      method: 'EXEC',
      origin: pinned.target,
      path: '/exec',
      query: [],
      headers: [],
      bodySha256: sha256(sshCommandBody({ command, stdin })),
      resources: [],
      operation: SSH_OPERATION,
    },
  };
}

/** OpenSSH's `SHA256:` fingerprint of a host's public key blob (unpadded base64), as people see it in `ssh-keygen -l`. */
export function sshFingerprintOf({ publicKeyBlob, sha256Base64 }: { readonly publicKeyBlob: Uint8Array; readonly sha256Base64: (bytes: Uint8Array) => string }): string {
  return `SHA256:${sha256Base64(publicKeyBlob).replace(/=+$/, '')}`;
}
