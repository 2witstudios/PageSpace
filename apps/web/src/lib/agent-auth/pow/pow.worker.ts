/**
 * Web worker that solves the agent signup proof of work off the main thread
 * (Agent Signup Phase 3), so the `/auth/agent` page stays responsive and can
 * show progress. Thin: the loop is `runPowSearch`, tested on its own.
 */
import { runPowSearch, type PowRunMessage, type PowRunRequest } from './pow-run';

// The app's tsconfig has the DOM lib, not WebWorker: name only what is used.
const scope = self as unknown as {
  location: { origin: string };
  onmessage: ((event: MessageEvent<PowRunRequest>) => void) | null;
  postMessage: (message: PowRunMessage) => void;
};

scope.onmessage = (event) => {
  // A dedicated worker only hears the page that created it (whose messages carry
  // an empty origin), so this never refuses a real request; it makes the
  // trust boundary explicit for anything that ever reaches it otherwise.
  if (event.origin !== '' && event.origin !== scope.location.origin) return;
  void runPowSearch(event.data, (message) => scope.postMessage(message), () => Promise.resolve());
};
