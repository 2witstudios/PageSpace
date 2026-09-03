/**
 * Copy and per-scale content for first-run onboarding.
 *
 * The copy here is settled — it has been through a voice review and every line
 * is deliberate. Do not rewrite it in passing. The specific things that were
 * removed and keep creeping back: hedging ("it *actually* does it"), the same
 * promise stated twice in one breath, and reassurance beats repeated until they
 * stop being read.
 *
 * This module imports nothing from React so it stays unit-testable and usable
 * server-side.
 */

export const SCALES = ['solo', 'small', 'mid', 'large'] as const;
export type Scale = (typeof SCALES)[number];

export interface ScaleOption {
  id: Scale;
  label: string;
  desc: string;
}

export interface ExamplePrompt {
  text: string;
  /**
   * Needs external integrations (Slack, GitHub, Calendar, external AI), which
   * onprem deployments do not have. Filtered out by {@link getExamples} rather
   * than shown and then failing on the user's very first request.
   */
  cloudOnly?: boolean;
}

export interface ScaleContent {
  /** Fills "…where ___ lives" on the second teaching screen. */
  workspaceNoun: string;
  /** The sample request in the mocked exchange. */
  sampleRequest: string;
  /** The assistant's reply in the mocked exchange. */
  sampleReply: string;
  /** Six things it did — plain verbs, no product nouns. */
  outcomes: readonly [string, string, string, string, string, string];
  /** What happens when one assistant is not enough. */
  escalation: string;
  /** How many assistants appear on the escalation screen. Rises with scale. */
  assistantCount: number;
  /** What the closing progress line says it set up to look after the work. */
  keeper: string;
  examples: readonly ExamplePrompt[];
}

export const SCALE_OPTIONS: readonly ScaleOption[] = [
  { id: 'solo', label: 'Just me', desc: 'Personal projects and life admin' },
  { id: 'small', label: '2–10 of us', desc: 'A small business or a tight team' },
  { id: 'mid', label: '11–50', desc: 'A few teams to keep in step' },
  { id: 'large', label: '50 or more', desc: 'A whole company, lots moving at once' },
];

/**
 * `Record<Scale, …>` with no index signature on purpose: adding a scale must
 * fail to compile until its content exists, rather than resolving to undefined
 * at runtime in front of a new user.
 */
export const SCALE_CONTENT: Record<Scale, ScaleContent> = {
  solo: {
    workspaceNoun: 'your real stuff',
    sampleRequest: 'Help me get on top of my life admin',
    sampleReply:
      'On it. I’ll make a place for your plans, your notes and the things you keep forgetting — then walk you through it.',
    outcomes: [
      'Wrote the awkward email',
      'Planned the trip',
      'Sorted the paperwork',
      'Kept the budget straight',
      'Built the reading list',
      'Chased the renewals',
    ],
    escalation: 'It gets a second pair of hands on it, and tells you when it’s done.',
    assistantCount: 2,
    keeper: 'Set up an assistant to look after this from here',
    examples: [
      { text: 'Help me get on top of my life admin' },
      { text: 'Turn my messy notes into something useful' },
      { text: 'Plan a trip and keep it all in one place' },
      { text: 'Keep track of my studies and my sources' },
      { text: 'Help me actually stick to a budget' },
    ],
  },
  small: {
    workspaceNoun: 'your real work',
    sampleRequest: 'Help me run my landscaping business',
    sampleReply:
      'On it. I’ll set up somewhere for your clients, your jobs and your invoices — then walk you through it.',
    outcomes: [
      'Wrote the proposal',
      'Built the job schedule',
      'Set up the team chat',
      'Kept the numbers straight',
      'Published the website',
      'Chased the follow-ups',
    ],
    escalation: 'It gets more hands on it, splits the work, and tells you when it’s done.',
    assistantCount: 3,
    keeper: 'Set up an assistant to look after this from here',
    examples: [
      { text: 'Help me run my landscaping business' },
      { text: 'Get my team off Slack and organised', cloudOnly: true },
      { text: 'Turn our notes into something we can search' },
      { text: 'Plan and run our community' },
      { text: 'Keep on top of quotes and invoices' },
    ],
  },
  mid: {
    workspaceNoun: 'your teams’ real work',
    sampleRequest: 'Help me keep three teams pointed the same way',
    sampleReply:
      'On it. I’ll set up a place for your plans, your updates and who’s doing what — then walk you through it.',
    outcomes: [
      'Wrote the onboarding guide',
      'Kept the roadmap current',
      'Ran the weekly updates',
      'Triaged the requests',
      'Published the handbook',
      'Followed up on every action',
    ],
    escalation: 'It puts a small team on it, divides the work, and reports back.',
    assistantCount: 4,
    keeper: 'Set up assistants to look after this from here',
    examples: [
      { text: 'Help me keep our teams pointed the same way' },
      { text: 'Replace our wiki with something people actually use' },
      { text: 'Run our weekly updates for me' },
      { text: 'Get every new hire up to speed on their own' },
      { text: 'Keep our plans and our chat in one place' },
    ],
  },
  large: {
    workspaceNoun: 'your company’s real work',
    sampleRequest: 'Help me run this without everything going through me',
    sampleReply:
      'On it. I’ll set up somewhere your teams can work, and put assistants on the parts that shouldn’t need you — then walk you through it.',
    outcomes: [
      'Reviewed the code changes',
      'Kept every runbook current',
      'Wrote up the incidents',
      'Briefed each team weekly',
      'Answered from your own docs',
      'Caught what fell through',
    ],
    escalation: 'It puts a whole crew on it — and they carry on without you.',
    assistantCount: 5,
    keeper: 'Set up assistants to look after this from here',
    examples: [
      { text: 'Help me run this without everything going through me' },
      { text: 'Put assistants on the work that shouldn’t need a person' },
      { text: 'Keep our documentation true to what we ship' },
      { text: 'Give every team its own assistant' },
      { text: 'Watch what’s happening and tell me what matters' },
    ],
  },
};

/** The "I don't know yet" escape hatch. Nobody can fail the last screen. */
export const UNSURE_PROMPT = 'I’m not sure yet — help me work it out';

/**
 * Example prompts for a scale, minus anything the deployment cannot honour.
 *
 * `cloudIntegrationsAllowed` comes from `areCloudIntegrationsAllowed()` — never
 * from `!isCloud()`, which would wrongly restrict tenant deployments.
 */
export function getExamples(scale: Scale, cloudIntegrationsAllowed: boolean): readonly ExamplePrompt[] {
  const all = SCALE_CONTENT[scale].examples;
  if (cloudIntegrationsAllowed) return all;
  return all.filter((example) => !example.cloudOnly);
}

/** The human label for a scale, as written on the first screen. */
export function getScaleLabel(scale: Scale): string {
  const option = SCALE_OPTIONS.find((o) => o.id === scale);
  // SCALE_OPTIONS is exhaustive over Scale; the fallback exists only so callers
  // never receive `undefined` if that ever stops being true.
  return option?.desc ?? scale;
}
