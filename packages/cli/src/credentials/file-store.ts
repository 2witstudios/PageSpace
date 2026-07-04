/**
 * File-fallback `CredentialStore` — `~/.pagespace/credentials.json`, mode 0600
 * (parent dir 0700), written atomically (temp file + rename). Refuses to read
 * a file with group/other permissions (fail closed) rather than silently
 * trusting it. All (de)serialization/permission decisions are pure functions
 * from serialize.ts; this class is the only place that touches `node:fs`.
 */
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  emptyCredentialsFile,
  getHost,
  isSecureMode,
  listSummaries,
  parseCredentialsFile,
  permissionFixItMessage,
  removeHost,
  serializeCredentialsFile,
  upsertHost,
} from './serialize.js';
import type { CredentialsFile, CredentialSummary, HostCredential } from './serialize.js';

export class PermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermissionError';
  }
}

export function defaultCredentialsPath(): string {
  return join(homedir(), '.pagespace', 'credentials.json');
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

export interface FileCredentialStoreOptions {
  readonly path?: string;
}

export class FileCredentialStore {
  private readonly path: string;

  constructor(options: FileCredentialStoreOptions = {}) {
    this.path = options.path ?? defaultCredentialsPath();
  }

  async get(host: string): Promise<HostCredential | null> {
    const file = await this.readFile();
    return getHost(file, host);
  }

  async set(host: string, credential: HostCredential): Promise<void> {
    const file = await this.readFile();
    await this.writeFile(upsertHost(file, host, credential));
  }

  async delete(host: string): Promise<void> {
    const file = await this.readFile();
    await this.writeFile(removeHost(file, host));
  }

  async list(): Promise<readonly CredentialSummary[]> {
    return listSummaries(await this.readFile());
  }

  private async readFile(): Promise<CredentialsFile> {
    // Open once and stat/read the SAME file descriptor rather than
    // stat-then-open-by-path — the latter has a TOCTOU gap where the path
    // could be swapped (e.g. a symlink) between the permission check and the
    // read, reading through a different, unchecked file.
    let handle;
    try {
      handle = await fs.open(this.path, 'r');
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') {
        return emptyCredentialsFile();
      }
      throw error;
    }

    try {
      const stat = await handle.stat();
      const mode = stat.mode & 0o777;
      if (!isSecureMode(mode)) {
        throw new PermissionError(permissionFixItMessage(this.path, mode));
      }

      const raw = await handle.readFile('utf8');
      return parseCredentialsFile(raw);
    } finally {
      await handle.close();
    }
  }

  private async writeFile(file: CredentialsFile): Promise<void> {
    const dir = dirname(this.path);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.chmod(dir, 0o700);

    const serialized = serializeCredentialsFile(file);
    const tmpPath = `${this.path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    const handle = await fs.open(tmpPath, 'w', 0o600);
    try {
      await handle.writeFile(serialized, 'utf8');
    } finally {
      await handle.close();
    }
    await fs.chmod(tmpPath, 0o600);
    await fs.rename(tmpPath, this.path);
    await fs.chmod(this.path, 0o600);
  }
}
