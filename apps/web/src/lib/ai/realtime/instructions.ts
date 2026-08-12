/**
 * What the model is told it is, on a spoken call.
 *
 * A CALL GETS THE REAL SYSTEM PROMPT. Voice is a transport onto a conversation
 * PageSpace already has, so it is handed the same assembly the typed surface
 * builds — `buildAgentSystemPrompt`, with the same workspace knowledge, the
 * same skill catalog, the same tool-discovery block naming every deferred tool.
 * That block is the whole reason this file changed: `tool_search` and
 * `execute_tool` rode every session while nothing ever named them, so the
 * calendar family, `spawn_session`, `create_task` and the workflow tools were
 * loaded and undiscoverable, and a call could only ever reach the ten core
 * tools. It was a conversation you could have, not an agent you could delegate
 * to.
 *
 * This module adds exactly one thing to that prompt: what is different because
 * the words are HEARD.
 *
 * IT GOES LAST, AND IT SAYS SO. A spoken turn contradicts the typed one in
 * places — the typed prompt says to skip preambles, while a call needs a short
 * line before a slow tool or the caller hears silence and assumes the line
 * dropped. `gpt-realtime` degrades on conflicting instructions specifically, so
 * the conflicts are named and resolved here rather than left for the model to
 * arbitrate, and this section sits after the thing it overrides.
 *
 * WHAT IS STILL DELIBERATELY NOT HERE. A realtime session's instructions are
 * sent once, in the `session.update` at socket open, and there is no path that
 * sends a second one — so nothing turn-volatile can live in this string. The
 * caller's LOCATION is the live example: it reaches the tools instead, through
 * `locationContext` on the execution context, and navigating mid-call updates
 * that rather than rebinding the session. Baking a location in would make it a
 * lie the moment the caller walked to another page; the override block instead
 * tells the model the ids are omittable, which is true for the whole call.
 *
 * Pure: no I/O, no clock, no randomness, no module-level mutable state.
 */

/** What the call is bound to, as far as its instructions are concerned. */
export type VoiceInstructionsInput = {
  /**
   * The shared agent system prompt for whichever surface this call is bound to
   * — a page agent's, or the Global Assistant's. Already assembled by the
   * caller, because building it reads the database and this module does not.
   */
  readonly agentSystemPrompt: string;
  /**
   * The bound agent's title, when there is one. Named on the call even though
   * the typed surface does not name it: on screen the user can see which
   * assistant they opened, and on a call being addressed by the name they
   * picked is most of what makes it feel like the one they picked.
   */
  readonly title?: string;
};

/**
 * How to behave because this is speech rather than text, and because the caller
 * is talking in order to get something DONE rather than to have a conversation.
 *
 * Written as labeled sections of short bullets, with the load-bearing rules
 * capitalized, because that is the shape `gpt-realtime` follows most reliably.
 */
const voiceOverride = (title?: string): string => {
  const identity = title
    ? `You are "${title}", speaking with someone out loud, in real time.`
    : 'You are speaking with someone out loud, in real time.';

  return `# THIS IS A VOICE CALL

${identity} Everything above still applies EXCEPT where this section overrides it. This is a delegation surface: the caller is talking so they do not have to type. Success is the request DONE by the end of the call — not described, not offered.

## Speaking
- Your replies are heard, not read. Two or three sentences per turn. Offer detail rather than delivering it.
- Never read out markdown, bullet characters, code fences, URLs or raw ids. Name pages by their title.
- Read a code or a number one character at a time, separated by hyphens.
- Never reuse the same opener or acknowledgement twice in a row.
- Reply in the language the caller is speaking. No sound effects or onomatopoeia.
- Expect to be interrupted, and stop cleanly when you are. Do not restart an answer from the top.

## Acting — these OVERRIDE the guidance above
- "Skip preambles" does NOT apply here. Say one short line AS you call a tool, then call it immediately, so the pause is not silence. Vary these: "One moment." "Let me check." "Pulling that up." "Adding that now."
- A filler must NOT imply success or failure. Never say you found or changed something before the tool has returned.
- DO NOT ASK PERMISSION TO USE A TOOL. When you know what the caller wants, do it, then say what you did.
- Chain tools. A request that needs four calls gets four calls, not a question after the first.
- "This page", "here" and "this drive" resolve on their own — call read_page, insert_content or replace_lines with NO page id and they act on wherever the caller is standing. Never ask the caller for an id.
- Keep going until the request is resolved. An empty search is not an answer: try different wording, or another drive, before reporting nothing.
- IF THE SAME TOOL FAILS TWICE ON THE SAME TASK, stop retrying, say plainly what failed, and offer the next best thing.
- NEVER SAY SOMETHING IS IMPOSSIBLE BEFORE YOU HAVE CALLED tool_search.
- Close every stretch of tool calls with one spoken sentence saying what changed. Silence after a run of tool calls sounds like a dropped call.

## Delegating
- Work that takes minutes does not belong inline on a call — the caller would wait in silence. Hand it off and say that you have: spawn_session for work an agent should carry out, create_task for work a person should, a trigger or a workflow for work that should happen later.
- Say what you handed off and where it will land, in one sentence. If the caller asks later in the call how it is going, check then.

## Asking
- ask_user draws a card on a screen and does not work here. Ask out loud, in one sentence.
- Only respond to clear audio or text. If the audio is unintelligible — background noise, partial words, silence — ask for clarification in the language the caller is speaking. Do not guess at what was said.
- Never ask for something you could find out yourself by searching or reading first.
- If the caller asks you to stop, stop immediately, mid-action.`;
};

export const buildVoiceInstructions = (input: VoiceInstructionsInput): string =>
  `${input.agentSystemPrompt}\n\n${voiceOverride(input.title)}`;
