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
 *
 * MUST be called lazily, only once a device flow is actually starting — never
 * at module scope. `router/routes.ts` imports every command module eagerly, so
 * a top-level call installs the listener on EVERY `pagespace` invocation, and
 * registering any SIGINT listener replaces Node's default terminate-on-Ctrl-C.
 * That would make the first Ctrl-C a no-op for unrelated commands like
 * `pagespace pages read`. `runConsent` calls this inside its device branch for
 * exactly this reason.
 */
export function createSigintFlag(): () => boolean {
  let interrupted = false;
  process.once('SIGINT', () => {
    interrupted = true;
  });
  return () => interrupted;
}
