/**
 * The App Store screenshot set.
 *
 * Six shots, ordered: a live published site first as the hook, then the story
 * behind it — ask, build, result, triggers, schedule. Only the first one to
 * three appear in App Store search results, so the order is load-bearing.
 *
 * Together they are the strongest answer we have to Guideline 4.2 (minimum
 * functionality): nobody looks at an agent creating seven pages, publishing a
 * site, and scheduling its own work, and calls the app a website in a wrapper.
 *
 * `capture` names a real screen recorded off a simulator running the shipping
 * build — guideline 2.3.3 requires screenshots show the app in actual use, so a
 * synthetic mock in the device frame is a rejection risk. Captures live at
 * `public/screenshots/ios/<device>/<slug>.png`.
 */
export type ShotDevice = "iphone" | "ipad";
export type Orientation = "portrait" | "landscape";

export interface Shot {
  slug: string;
  tag?: string;
  /** Rendered as separate lines, so the break is deliberate rather than reflowed. */
  headline: string[];
  subline: string;
}

export const SHOTS: Shot[] = [
  {
    // Leads deliberately. Only the first one to three appear in App Store
    // search results, and a live customer site stops the scroll where a dark
    // chat UI does not — it is also the single clearest refutation of "this is
    // a website in a wrapper", since a wrapper cannot publish one.
    slug: "publish",
    tag: "Publish",
    headline: ["Change your site", "by asking."],
    subline: "Published to a real address, then edited in plain language.",
  },
  {
    slug: "ask",
    tag: "Ask",
    headline: ["Tell it what", "you need."],
    subline: "It asks what a colleague would ask before starting.",
  },
  {
    slug: "builds",
    tag: "Build",
    headline: ["Then it", "builds it."],
    subline: "Folders, documents, sheets and task lists — created, not suggested.",
  },
  {
    slug: "result",
    tag: "Workspace",
    headline: ["A workspace,", "not a blank page."],
    subline: "Twenty-two pages across six folders, structured and ready to work in.",
  },
  {
    slug: "triggers",
    tag: "Automate",
    headline: ["Tasks that", "start themselves."],
    subline: "Hand a task to an agent when it comes due, or the moment it's done.",
  },
  {
    slug: "workflows",
    tag: "Schedule",
    headline: ["Work that", "keeps running."],
    subline: "Put the recurring work on a schedule and leave it to the agent.",
  },
];

export const DEVICES: ShotDevice[] = ["iphone", "ipad"];

/**
 * The App Store's current required canvas sizes. Captured 1:1, never scaled.
 *
 * iPad is landscape on purpose: PageSpace is a three-pane product, and portrait
 * squeezes it into something closer to a large phone. App Store Connect accepts
 * either orientation for 13" iPad so long as the dimensions match the one you
 * pick. iPhone stays portrait, as phone screenshots universally are.
 */
export const CANVAS: Record<
  ShotDevice,
  { width: number; height: number; label: string; orientation: Orientation }
> = {
  iphone: { width: 1320, height: 2868, label: 'iPhone 6.9"', orientation: "portrait" },
  ipad: { width: 2752, height: 2064, label: 'iPad 13"', orientation: "landscape" },
};

export const capturePath = (device: ShotDevice, slug: string) =>
  `/screenshots/ios/${device}/${slug}.png`;
