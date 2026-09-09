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

/**
 * Apple's official product bezels, from developer.apple.com/design/resources
 * ("Product Bezels", PNG). iPhone 17 Pro Max — Deep Blue, and iPad Pro (M5)
 * 13" — Space Black, both chosen to sit against the dark space backdrop.
 *
 * Using Apple hardware art in marketing carries conditions — see
 * developer.apple.com/app-store/marketing/guidelines/#section-products. In
 * short: do not alter the hardware imagery, and do not imply endorsement.
 *
 * The aperture rect is the fully-transparent screen cut-out, measured off each
 * PNG's alpha channel rather than eyeballed — a few pixels out shows as a seam
 * where the capture meets the bezel. Both happen to be exact 1:1 matches for
 * their capture, so the screenshot drops in without resampling.
 */
export const FRAME: Record<
  ShotDevice,
  {
    src: string;
    width: number;
    height: number;
    /** Screen cut-out. `radius` matters: Apple leaves the rounded corner
     *  transparent and expects the screenshot to be masked to it, so a square
     *  capture otherwise pokes out past the bezel. Measured from each PNG's
     *  alpha and curve-fitted — 62pt at 3x, and 30pt at 2x. */
    screen: { x: number; y: number; w: number; h: number; radius: number };
  }
> = {
  iphone: {
    src: "/device-frames/iphone.png",
    width: 1470,
    height: 3000,
    screen: { x: 75, y: 66, w: 1320, h: 2868, radius: 186 },
  },
  ipad: {
    src: "/device-frames/ipad.png",
    width: 3000,
    height: 2300,
    screen: { x: 124, y: 118, w: 2752, h: 2064, radius: 60 },
  },
};

export const capturePath = (device: ShotDevice, slug: string) =>
  `/screenshots/ios/${device}/${slug}.png`;
