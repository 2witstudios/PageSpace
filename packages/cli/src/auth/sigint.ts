/**
 * A one-shot "has the user hit Ctrl-C?" flag, as a plain function.
 *
 * The device flow polls this between waits so a cancelled `--device` command
 * stops at the next poll boundary instead of hanging until the code expires.
 * It is a function rather than an event emitter deliberately: `device-flow.ts`
 * stays I/O-free and fully unit-testable, with the one `process.once` call
 * confined here.
 *
 * Shared by every command that can run a device flow (`login --device`,
 * `keys create --device`, `keys use --device`, and the wizard) — each used to
 * need its own copy, and a copy that forgot the `once` semantics would leak a
 * listener per invocation.
 */
export function createSigintFlag(): () => boolean {
  let interrupted = false;
  process.once('SIGINT', () => {
    interrupted = true;
  });
  return () => interrupted;
}
