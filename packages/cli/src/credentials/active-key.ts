/**
 * The active-key file (`pagespace keys use`) — a small, NON-SECRET JSON map
 * of host → active key name, stored next to the credential file-store
 * fallback (`~/.pagespace/active-keys.json`; see `file-store.ts`'s
 * `defaultCredentialsPath` for the shared directory). It holds no secret
 * material — only the NAME of a stored credential — so unlike
 * `credentials.json` there is no permission-mode gate on reads: a corrupt,
 * missing, or unreadable file simply resolves to "no active key" (`null`),
 * never a thrown error. Writes are still atomic (temp file + rename) so a
 * crash mid-write can't leave a torn file behind.
 *
 * This file is the only place that touches `node:fs` for the active-key
 * map; `run.ts` and command handlers receive an `ActiveKeyStore` injected
 * (`bin.ts` constructs the real one), matching how the credential store is
 * threaded.
 */
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface ActiveKeyStore {
  /** The active key name for `host`, or `null` (missing/corrupt file, no entry). Never throws. */
  getActiveKey(host: string): Promise<string | null>;
  setActiveKey(host: string, name: string): Promise<void>;
  clearActiveKey(host: string): Promise<void>;
}

export function defaultActiveKeysPath(): string {
  return join(homedir(), '.pagespace', 'active-keys.json');
}

/** Pure: tolerant parse of the file's raw text into a host → name map; anything malformed contributes nothing. */
export function parseActiveKeysFile(raw: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  const entries = Object.entries(parsed as Record<string, unknown>).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0,
  );
  return Object.fromEntries(entries);
}

export interface FileActiveKeyStoreOptions {
  readonly path?: string;
}

export class FileActiveKeyStore implements ActiveKeyStore {
  private readonly path: string;

  constructor(options: FileActiveKeyStoreOptions = {}) {
    this.path = options.path ?? defaultActiveKeysPath();
  }

  async getActiveKey(host: string): Promise<string | null> {
    const map = await this.readFile();
    return Object.hasOwn(map, host) ? map[host] : null;
  }

  async setActiveKey(host: string, name: string): Promise<void> {
    const map = await this.readFile();
    await this.writeFile({ ...map, [host]: name });
  }

  async clearActiveKey(host: string): Promise<void> {
    const map = await this.readFile();
    if (!Object.hasOwn(map, host)) return;
    const remaining = { ...map };
    delete remaining[host];
    await this.writeFile(remaining);
  }

  private async readFile(): Promise<Record<string, string>> {
    let raw: string;
    try {
      raw = await fs.readFile(this.path, 'utf8');
    } catch {
      return {};
    }
    return parseActiveKeysFile(raw);
  }

  private async writeFile(map: Record<string, string>): Promise<void> {
    const dir = dirname(this.path);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const tmpPath = `${this.path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    try {
      await fs.writeFile(tmpPath, `${JSON.stringify(map, null, 2)}\n`, 'utf8');
      await fs.rename(tmpPath, this.path);
    } catch (error) {
      await fs.unlink(tmpPath).catch(() => {});
      throw error;
    }
  }
}

/**
 * The fail-closed default `run.ts` uses when no store is injected: no active
 * key ever resolves, and activations/clears are refused loudly rather than
 * silently dropped — only `bin.ts` (and tests) know a real place to keep the
 * map.
 */
export function createNullActiveKeyStore(): ActiveKeyStore {
  return {
    async getActiveKey() {
      return null;
    },
    async setActiveKey() {
      throw new Error('No active-key store is available in this environment.');
    },
    async clearActiveKey() {
      throw new Error('No active-key store is available in this environment.');
    },
  };
}
