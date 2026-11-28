/**
 * Reads a secret for `pagespace login --agent` / `pagespace agent claim`:
 * NEVER from argv (argv lands in shell history and `ps` output). Piped stdin
 * when stdin is not a terminal (`echo "$SECRET" | pagespace login --agent`),
 * the interactive prompt otherwise. Trimmed; `null` when nothing was given.
 *
 * The one place this package reads `process.stdin` for a value; commands
 * receive it as an injected dependency.
 */
export type ReadSecret = (params: { isTTY: boolean; prompt: (message: string) => Promise<string>; label: string }) => Promise<string | null>;

const MAX_SECRET_BYTES = 4096;

async function readPipedStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_SECRET_BYTES) break;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export const readSecret: ReadSecret = async ({ isTTY, prompt, label }) => {
  const raw = isTTY ? await prompt(`${label}: `) : await readPipedStdin();
  const value = raw.trim();
  return value.length > 0 ? value : null;
};
