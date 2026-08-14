import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * ONLY A DELIBERATE STOP SHOULD STOP IT.
 *
 * The user's rule, verbatim. It has two clauses and only the first was ever reasoned about:
 *
 *   (a) do not abort the COMPUTE — the generation must survive a client going away;
 *   (b) do not end the run's VISIBLE life — the user must not lose sight of a reply they are
 *       still waiting for.
 *
 * `disconnect-immunity.test.ts` is the tripwire for (a), on the server side. This is the
 * tripwire for (b), on the client, and it exists because clause (b) was violated repeatedly by
 * code that had explicitly considered clause (a) and concluded it was fine:
 *
 *   - `useDualModeChat.ts` stopped the global stream when you selected an agent, and the agent
 *     stream when you deselected one. Switching which mode you are LOOKING AT is not a stop.
 *   - `GlobalAssistantView.tsx` had the same effect, and documented it as an "accepted
 *     residual" on the grounds that "the server generation continues". True — and exactly the
 *     half that does not matter. The tokens kept arriving on a channel the tab had stopped
 *     reading, so the reply the user came back to was frozen at the moment they glanced away.
 *   - `useResumeBootstrap` stopped a "frozen local transport" on app resume, guarded by a
 *     heuristic about whether a live own stream was running.
 *   - `useConversationSendHandoff` stopped the current read on EVERY cross-conversation send.
 *
 * Every one of them was a local `stop()`, which is the trap: a local stop is invisible in
 * review precisely because it looks harmless. It is harmless to the compute and fatal to the
 * user's view of it.
 *
 * ── THE POSITIVE HALF MATTERS AS MUCH AS THE PROHIBITION ──────────────────────────────────
 *
 * A Stop button that only cancels locally is indistinguishable, from the user's side, from one
 * that works: the button flips back to Send while the generation keeps running its write tools
 * and keeps billing. So this file also asserts that the deliberate path REACHES
 * `/api/ai/abort`. Forbidding local stops without pinning the real one would leave a client
 * that cannot stop anything at all — which is a different bug, not a fix.
 *
 * ── WHY SOURCE-LEVEL ──────────────────────────────────────────────────────────────────────
 *
 * Same reasoning as `disconnect-immunity.test.ts`. What we want to forbid is the PRESENCE of
 * the wiring, anywhere, forever. A behavioural test would pin only the paths it happened to
 * exercise, and the whole point is that these get reintroduced in paths nobody thought to
 * exercise — a new surface, a new mode switch, a new resume handler.
 *
 * IF THIS FAILS, do not add your file to the allowlist. Ask what you are actually trying to
 * achieve. If it is "stop the generation", call the abort endpoint. If it is "stop rendering
 * this", you do not need to stop anything — the store is app-wide and a component that is not
 * mounted simply is not reading it.
 */

const WEB_SRC = join(import.meta.dirname, '../../../..');

/**
 * The ONE module allowed to stop a generation, and the test file that pins it.
 *
 * Deliberately short. A second entry here should be an argument, not an edit.
 */
const DELIBERATE_STOP_PATH = 'lib/ai/core/stream-abort-client.ts';

/**
 * Files exempt from the `useChat` prohibition because they only NAME it — in prose, explaining
 * why it is gone. The check below already ignores comment lines; this is the belt to that
 * braces for a file that mentions it in a string.
 */
const PROSE_ONLY: ReadonlySet<string> = new Set([
  'lib/ai/core/__tests__/only-a-deliberate-stop.test.ts',
]);

/**
 * `.stop()` is not exclusively a chat verb, and this tripwire must not become the reason
 * somebody cannot stop a microphone. These are the non-chat stop receivers in this codebase:
 * speech recognition, media tracks, and the realtime voice connection. Matched on the RECEIVER,
 * not on the file, so a chat stop smuggled into a voice module still fails.
 */
const NON_CHAT_STOP_RECEIVERS = [
  /\brecognition(Ref\.current)?\??\.stop\(/,
  /\btrack\.stop\(/,
  /\.getTracks\(\)/,
  /\bconnection\??\.stop\(/,
  // The voice session's own controls handle, as its tests drive it.
  /\bcontrols\??\.stop\(/,
];

/** Named local-stop handles from the design this replaces. Any survivor is a regression. */
const FORBIDDEN_STOP_IDENTIFIERS = [
  /\bglobalStop\s*\(/,
  /\bagentStop\s*\(/,
  /\brawStop\s*\(/,
];

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
      continue;
    }
    if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
};

const isComment = (line: string): boolean =>
  line.startsWith('//') || line.startsWith('*') || line.startsWith('/*');

interface Offence {
  file: string;
  line: number;
  text: string;
}

const scan = (predicate: (line: string) => boolean): Offence[] => {
  const offences: Offence[] = [];
  for (const file of walk(WEB_SRC)) {
    const rel = relative(WEB_SRC, file);
    if (PROSE_ONLY.has(rel)) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((raw, index) => {
      const line = raw.trim();
      if (isComment(line)) return;
      if (predicate(line)) offences.push({ file: rel, line: index + 1, text: line });
    });
  }
  return offences;
};

describe('only a deliberate stop should stop it', () => {
  it('no module imports useChat — owning the send shell is what removes the one-body constraint', () => {
    const offences = scan(
      (line) => /from\s+['"]@ai-sdk\/react['"]/.test(line) && /useChat/.test(line),
    );

    expect(
      offences,
      'A module is importing `useChat` again. The AI SDK\'s `Chat` cannot consume two response '
        + 'bodies at once, and every surface here passes a constant id — so ONE `Chat` would '
        + 'serve every conversation on that surface and a second send would corrupt the shared '
        + 'messages array. That constraint is why `useConversationSendHandoff` existed at all: '
        + 'a `stop()` on every cross-conversation send and a refusal when the status would not '
        + 'settle. Use `useChatSession` (lib/ai/shared/hooks/useChatSession.ts), which sends '
        + 'with `fetch` and holds no shared response body.',
    ).toEqual([]);
  });

  it('nothing calls a local chat stop — cancelling a read ends the reply\'s visible life, not the generation', () => {
    const offences = scan((line) => FORBIDDEN_STOP_IDENTIFIERS.some((re) => re.test(line)));

    expect(
      offences,
      'A local chat stop is back. It stops NOTHING server-side — streams are server-owned and '
        + 'survive client disconnect by design — so all it achieves is ending the run\'s '
        + 'VISIBLE life while it keeps generating, keeps calling write tools, and keeps '
        + 'billing.\n'
        + 'If the user pressed Stop, go through `useStopStream` -> `/api/ai/abort`. If this is '
        + 'a mode switch, a resume, an unmount, or a cross-conversation send, you do not need '
        + 'to stop anything: switching what you LOOK AT is not a stop, and the stream store is '
        + 'app-wide.',
    ).toEqual([]);
  });

  it('no chat stream is aborted outside the deliberate-stop path', () => {
    const offences = scan((line) => {
      if (!/\.stop\(\)/.test(line)) return false;
      // Microphones, media tracks and the voice connection are not chat streams.
      return !NON_CHAT_STOP_RECEIVERS.some((re) => re.test(line));
    }).filter((offence) => offence.file !== DELIBERATE_STOP_PATH);

    expect(
      offences,
      'Something calls `.stop()` on what looks like a chat stream. Only a deliberate user Stop '
        + `may end a generation, and it does so through ${DELIBERATE_STOP_PATH} by POSTing to `
        + '/api/ai/abort — not by cancelling anything locally.',
    ).toEqual([]);
  });

  it('the deliberate Stop REACHES /api/ai/abort — a local cancel stops nothing server-side', () => {
    const source = readFileSync(join(WEB_SRC, DELIBERATE_STOP_PATH), 'utf8');

    expect(
      source.includes('/api/ai/abort'),
      `${DELIBERATE_STOP_PATH} no longer names /api/ai/abort. Forbidding local stops is only `
        + 'half the rule: without the server abort the Stop button silently does nothing while '
        + 'the generation runs on. The endpoint is the only thing that reaches the server-side '
        + 'abort registry.',
    ).toBe(true);

    // Both names a Stop can hold. `messageId` once the stream exists; `conversationId` for the
    // 0.5-3s TTFB window, where the server has not issued a messageId for the client to name —
    // precisely when a user who spotted a typo presses Stop.
    expect(source).toMatch(/abortActiveStreamByMessageId/);
    expect(source).toMatch(/abortActiveStreamByConversation/);
  });

  it('useStopStream routes to that path and nowhere else', () => {
    const raw = readFileSync(join(WEB_SRC, 'hooks/useStopStream.ts'), 'utf8');
    // Comment-stripped, because the file explains AT LENGTH what `rawStop` was and why it is
    // gone — and an explanation of a deleted mechanism is exactly what we want to keep.
    const source = raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => !isComment(line))
      .join('\n');

    expect(
      /abortActiveStreamByMessageId/.test(source) && /abortActiveStreamByConversation/.test(source),
      'useStopStream must dispatch to the abort endpoint under both names — see the test above '
        + 'for why the conversation-keyed fallback is not optional.',
    ).toBe(true);

    // The signature itself is the guarantee: no local-stop input means no local stop is
    // reachable from the one Stop the UI offers.
    expect(
      /rawStop/.test(source),
      'useStopStream has taken a `rawStop` again. The Stop path must have no local-abort input '
        + 'at all — an optional one is an invitation.',
    ).toBe(false);
  });

  it('the mode-switch stops in useDualModeChat and GlobalAssistantView stay deleted', () => {
    const dualMode = readFileSync(join(WEB_SRC, 'hooks/useDualModeChat.ts'), 'utf8');
    const globalView = readFileSync(
      join(WEB_SRC, 'components/layout/middle-content/page-views/dashboard/GlobalAssistantView.tsx'),
      'utf8',
    );

    // Asserted on the STRUCTURE, not on a string: what must not come back is an effect that
    // reacts to `selectedAgent` by stopping something. Both files discuss these deletions at
    // length in prose, which is why the scans above skip comment lines.
    for (const [label, source] of [
      ['useDualModeChat.ts', dualMode],
      ['GlobalAssistantView.tsx', globalView],
    ] as const) {
      const executable = source
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => !isComment(line))
        .join('\n');

      expect(
        /Stop\s*\(\s*\)/.test(executable),
        `${label} calls a stop again on a mode switch. Selecting an agent — or deselecting one `
          + '— is a pure view change. Both modes\' streams live in the same store, written by '
          + 'the same app-wide registry, so a switch changes only which is displayed.',
      ).toBe(false);
    }
  });

  it('the app-wide stream registry has no mount-scoped teardown', () => {
    const source = readFileSync(
      join(WEB_SRC, 'lib/ai/streams/streamSessionRegistry.ts'),
      'utf8',
    );

    // The registry is what makes "send a message and leave" work. A `release()` that could
    // close a session on a refcount reaching zero would put the stream's life back under a
    // component's control — which is clause (b) again, one layer down.
    expect(
      /export const release/.test(source),
      'The stream session registry has grown a `release`. A component unmounting is not '
        + 'evidence that a generation stopped; every version of this that let a mount count '
        + 'close a session ended with the store entry vanishing and the reply disappearing '
        + 'while the server kept generating.',
    ).toBe(false);
  });
});
