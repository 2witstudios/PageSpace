/**
 * The App Store screenshot set, captured once and rendered for both devices.
 *
 * `capture` names a real screen recorded off a simulator running the shipping
 * build — App Review guideline 2.3.3 requires screenshots show the app in
 * actual use, so a synthetic mock in the device frame is a rejection risk.
 * Captures live at `public/screenshots/ios/<device>/<slug>.png`.
 */
export type ShotDevice = "iphone" | "ipad";

export interface Shot {
  slug: string;
  tag?: string;
  /** Rendered as separate lines, so the break is deliberate rather than reflowed. */
  headline: string[];
  subline: string;
}

export const SHOTS: Shot[] = [
  {
    slug: "workspace",
    tag: "Workspace",
    headline: ["The AI for", "working."],
    subline: "Partner for any project, workspace for any team.",
  },
  {
    slug: "ai-chat",
    tag: "Ask",
    headline: ["It already", "read it."],
    subline: "Answers grounded in your own pages — not the open internet.",
  },
  {
    slug: "channels",
    tag: "Together",
    headline: ["Chat where", "the work is."],
    subline: "Channels and DMs beside the documents they are about.",
  },
  {
    slug: "tasks",
    tag: "Tasks",
    headline: ["Plans that", "stay current."],
    subline: "Boards, assignments, and progress that roll up on their own.",
  },
  {
    slug: "search",
    tag: "Find",
    headline: ["Everything.", "One search."],
    subline: "Jump to any page, message, or file in a keystroke.",
  },
];

export const DEVICES: ShotDevice[] = ["iphone", "ipad"];

/** The App Store's current required canvas sizes. Captured 1:1, never scaled. */
export const CANVAS: Record<ShotDevice, { width: number; height: number; label: string }> = {
  iphone: { width: 1320, height: 2868, label: 'iPhone 6.9"' },
  ipad: { width: 2064, height: 2752, label: 'iPad 13"' },
};

export const capturePath = (device: ShotDevice, slug: string) =>
  `/screenshots/ios/${device}/${slug}.png`;
