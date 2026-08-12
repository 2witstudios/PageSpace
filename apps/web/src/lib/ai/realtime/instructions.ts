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

/**
 * What the model can actually call, as the override block needs to know it.
 *
 * A RULE THAT NAMES A TOOL THE MODEL DOES NOT HAVE IS WORSE THAN NO RULE. It
 * spends a turn on a call that is rejected, and spends it out loud, in front of
 * someone waiting. Both halves are needed because they answer different
 * questions: `tool_search` only ever exists in the exposed set, and
 * `spawn_session` only ever exists in the reachable one.
 */
export type VoiceToolReach = {
  /** Advertised with full schemas — the core tools, plus the scaffolding when there is any. */
  readonly exposed: readonly string[];
  /** Everything callable at all, including the half deferred behind `execute_tool`. */
  readonly reachable: readonly string[];
};

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
  /** Omitted means "assume nothing is reachable" — the safe direction. */
  readonly tools?: VoiceToolReach;
};

/**
 * Where long work goes, each paired with the tools that have to be reachable
 * before it can be offered. Any one of them is enough — the phrase describes a
 * destination, and a caller who can set a trigger but not a workflow can still
 * be told work can happen later.
 */
const HAND_OFFS: readonly (readonly [readonly string[], string])[] = [
  [['spawn_session'], 'spawn_session for work an agent should carry out'],
  [['create_task'], 'create_task for work a person should'],
  [
    ['set_task_trigger', 'create_workflow'],
    'a trigger or a workflow for work that should happen later',
  ],
];

/**
 * How to behave because this is speech rather than text, and because the caller
 * is talking in order to get something DONE rather than to have a conversation.
 *
 * Written as labeled sections of short bullets, with the load-bearing rules
 * capitalized, because that is the shape `gpt-realtime` follows most reliably.
 */
const voiceOverride = (title: string | undefined, tools: VoiceToolReach): string => {
  const identity = title
    ? `You are "${title}", speaking with someone out loud, in real time.`
    : 'You are speaking with someone out loud, in real time.';

  // An agent allowed only core tools gets no `tool_search` and no
  // `execute_tool` — there is nothing deferred for them to reach — so the rule
  // sending the model to search before refusing would name a tool that is not
  // there. In that case everything it can do is already in front of it, and
  // saying so is the honest replacement.
  const canSearch = tools.exposed.includes('tool_search');
  const beforeRefusing = canSearch
    ? '- NEVER SAY SOMETHING IS IMPOSSIBLE BEFORE YOU HAVE CALLED tool_search.'
    : '- Every tool you have is already listed for you. If none of them fits, say so plainly rather than guessing at one.';

  // Same rule for the hand-off targets: each is offered only when the agent can
  // actually reach it, and an agent granted none of them cannot delegate at all.
  // Naming one anyway would spend a turn on a call `execute_tool` rejects — out
  // loud, in front of someone waiting.
  const handOffs = HAND_OFFS.filter(([names]) =>
    names.some((name) => tools.reachable.includes(name)),
  ).map(([, phrase]) => phrase);

  const delegating =
    handOffs.length === 0
      ? `## Long work
- Work that takes minutes does not belong inline on a call — the caller would wait in silence. Say what you are starting, work through it in steps, and keep saying where you have got to.`
      : `## Delegating
- Work that takes minutes does not belong inline on a call — the caller would wait in silence. Hand it off and say that you have: ${handOffs.join(', ')}.
- Say what you handed off and where it will land, in one sentence. If the caller asks later in the call how it is going, check then.`;

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
${beforeRefusing}
- Close every stretch of tool calls with one spoken sentence saying what changed. Silence after a run of tool calls sounds like a dropped call.

${delegating}

## What you were told, and when
- Everything above was assembled when this call started and is never re-sent. If you change any of it during the call — bind or clear a plan, edit your memory page, move or rename something — YOUR OWN TOOL RESULT IS WHAT IS CURRENT, and the description above is out of date from that moment on.
- Never re-follow a standing instruction about something you have since changed. Say what the change was, then work from it.

## Asking
- ask_user draws a card on a screen and does not work here. Ask out loud, in one sentence.
- Only respond to clear audio or text. If the audio is unintelligible — background noise, partial words, silence — ask for clarification in the language the caller is speaking. Do not guess at what was said.
- Never ask for something you could find out yourself by searching or reading first.
- If the caller asks you to stop, stop immediately, mid-action.`;
};

const NOTHING_REACHABLE: VoiceToolReach = { exposed: [], reachable: [] };

export const buildVoiceInstructions = (input: VoiceInstructionsInput): string =>
  `${input.agentSystemPrompt}\n\n${voiceOverride(input.title, input.tools ?? NOTHING_REACHABLE)}`;
