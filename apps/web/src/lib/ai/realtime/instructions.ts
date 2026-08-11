/**
 * What the model is told it is, on a spoken call.
 *
 * Every voice session used to be minted with a model and nothing else, so the
 * call ran on the realtime model's generic default persona no matter which
 * assistant the user had selected — while the UI, and the changelog, presented
 * it as talking to that assistant. This is the fix for the half of that gap
 * that is text: who you are, and what a spoken turn is.
 *
 * TWO PARTS, IN THIS ORDER:
 *   1. THE MEDIUM. A spoken answer cannot be skimmed, scrolled back through, or
 *      skipped over — and the caller can interrupt, which a text surface has no
 *      equivalent of. That changes what a good answer looks like far more than
 *      which assistant is speaking does, so it comes first and applies to every
 *      call.
 *   2. THE ASSISTANT. A page agent's own `systemPrompt` verbatim, because that
 *      is exactly the string its owner wrote and the text surface sends it
 *      unmodified too. Wrapping, summarising or "adapting" it here would be a
 *      second interpretation of a field that already has one.
 *
 * WHAT IS DELIBERATELY NOT HERE. The text pipeline's system prompt also carries
 * a page tree, agent memory, a skill catalog, tool-discovery guidance and the
 * turn-volatile location block. None of it is copied in:
 *   - most of it is turn-volatile, and a realtime session's instructions are
 *     set once at attach and are not re-sent per turn, so a copy would be stale
 *     for the rest of the call;
 *   - the tool guidance is written for a surface where the model can run a long
 *     tool loop while the reader waits silently, which is the opposite of what
 *     a caller experiences;
 *   - and a second copy of any of it is a copy that drifts from
 *     `page-chat-turn.ts` the first time either changes.
 * Where the model is standing still reaches the tools, through
 * `locationContext` on the execution context — which is the part that has to be
 * live, and is.
 *
 * Pure: no I/O, no clock, no randomness, no module-level mutable state.
 */

/**
 * The assistant a call is bound to, as far as its instructions are concerned.
 * An empty object is the Global Assistant — or an unbound call, which gets the
 * same persona because it is the same one the dashboard talks to.
 */
export type VoiceInstructionsInput = {
  /** The agent page's title. Absent for the Global Assistant. */
  readonly title?: string;
  /** The agent's own configured prompt, when its owner wrote one. */
  readonly systemPrompt?: string;
};

/**
 * How to behave because this is speech rather than text.
 *
 * Every line here is about the medium, not about PageSpace: brevity because a
 * listener cannot skim, plain prose because markdown is read aloud as noise,
 * and a short acknowledgement before a slow tool because the alternative is
 * silence the caller reads as a dropped connection.
 */
const SPOKEN_TURN_PREAMBLE = [
  'You are speaking with someone out loud, in real time. Your replies are heard, not read.',
  '',
  '- Keep answers short. Two or three sentences is usually right; offer detail rather than delivering it.',
  '- Speak in plain prose. Never read out markdown, bullet characters, code fences, URLs or raw ids.',
  '- If a tool will take a moment, say so in a few words first, so the pause is not silence.',
  '- Expect to be interrupted, and stop cleanly when you are. Do not restart an answer from the top.',
  '- If you did not catch something, ask — do not guess at what was said.',
].join('\n');

/** What the model is, when nothing more specific is bound. */
const PAGESPACE_ASSISTANT = [
  'You are the PageSpace assistant. PageSpace is the workspace this person keeps their',
  'pages, drives, tasks and agents in, and your tools act on that workspace on their behalf.',
].join(' ');

export const buildVoiceInstructions = (assistant: VoiceInstructionsInput): string => {
  const parts = [SPOKEN_TURN_PREAMBLE];

  const systemPrompt = assistant.systemPrompt?.trim();
  if (systemPrompt) {
    // The agent's own words, verbatim. Its title is named alongside rather than
    // folded in, because a prompt that already establishes a persona must not
    // be contradicted by a second one bolted on top.
    parts.push(
      assistant.title
        ? `You are "${assistant.title}", an assistant in PageSpace. Your instructions follow.`
        : 'You are an assistant in PageSpace. Your instructions follow.',
      systemPrompt,
    );
  } else if (assistant.title) {
    // A page agent whose owner configured no prompt: it is still a distinct
    // assistant with a name, and being called by that name is most of what
    // makes it feel like the one the user picked.
    parts.push(`You are "${assistant.title}", an assistant in PageSpace.`, PAGESPACE_ASSISTANT);
  } else {
    parts.push(PAGESPACE_ASSISTANT);
  }

  return parts.join('\n\n');
};
