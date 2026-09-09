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
  /**
   * Which devices ship this frame. Defaults to both.
   *
   * The sets are allowed to diverge — App Store Connect takes a different
   * count per device, and a frame whose copy does not match its capture is
   * worse than one fewer frame.
   */
  devices?: ShotDevice[];
  /** Rendered as separate lines, so the break is deliberate rather than reflowed. */
  headline: string[];
  /**
   * Two lines in portrait; joined with a space onto one line in landscape.
   * Keep the joined form under ~32 characters — beyond that it wraps in
   * landscape and the device, which is positioned for a single line, rides
   * over the second.
   */
  headline: string[];

  /**
   * Subtext under the headline.
   *
   * Keep it under ~96 characters. Past that it wraps to a second line in
   * landscape and the device, positioned for one, rides over it.
   *
   * Most captions were cut because they argued with the picture rather than
   * adding to it: restating the headline ("edited in plain language" under
   * "Change your site by asking"), or quoting figures from this one demo as
   * though they were product claims ("Twenty-two pages across six folders").
   * The captures tell the story; a caption has to earn its place.
   *
   * `builds` keeps one because naming the page types is the fastest way to
   * show the breadth, and no screenshot of a single screen can.
   */
  subline?: string;
}

export const SHOTS: Shot[] = [
  {
    // The thesis, and the frame that earns it: one sentence in, and an agent
    // builds an entire business workspace. Everything after is a facet of
    // "any project, any team" -- the landing hero's promise.
    slug: "builds",
    headline: ["The AI for", "any project."],
    subline: "Documents, sheets, channels, tasks, canvases and code.",
  },
  {
    slug: "team",
    headline: ["The workspace", "for any team."],
    subline: "People and AI agents in the same channels, answering from your pages, not the open internet.",
  },
  {
    slug: "agent",
    headline: ["Shape it to", "your business."],
    subline: "Choose the model, write the instructions. It works inside the workspace, not from the sidelines.",
  },
  {
    slug: "tasks",
    headline: ["Assign work.", "Even to an agent."],
    subline: "Agents take tasks, assignees and due dates like anyone else on the team.",
  },
  {
    slug: "publish",
    headline: ["Change your site", "by asking."],
    subline: "Publish any page to a real address, then change it in plain language.",
  },
  {
    // Sells authorization, not the role editor. The depth is the point: a buyer
    // asking "can I let an AI near this?" needs the answer to be specific.
    // Every claim here is from the security page.
    slug: "permissions",
    headline: ["Permissions apply", "to the AI too."],
    subline: "Roles, per-page access, a tamper-evident audit trail, and restore points before every AI change.",
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

/** The shots that ship for a given device, in order. */
export const shotsFor = (device: ShotDevice): Shot[] =>
  SHOTS.filter((s) => (s.devices ?? DEVICES).includes(device));
