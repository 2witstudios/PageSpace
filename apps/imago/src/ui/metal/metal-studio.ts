// What Imago's orb reflects (docs/imago/liquid-metal-engine.md §D3): the `--metal-*` colour tokens
// resolved for the current theme, plus the per-theme gains. Custom properties come back from
// getComputedStyle unresolved, and light-dark() only resolves through a real property, so each
// token goes through a hidden probe's `color` and then a 1px canvas for its sRGB bytes.

export type Rgb = readonly [number, number, number];

export type Studio = {
  readonly sky: Rgb;
  readonly room: Rgb;
  readonly warm: Rgb;
  readonly flag: Rgb;
  readonly rim: Rgb;
  readonly key: Rgb;
  /** The page itself, where reflected rays leave the viewport. */
  readonly floor: Rgb;
  readonly keyGain: number;
  readonly pageGain: number;
  /** Head-on reflectance: on a white page the metal needs more to read as silver, not faded. */
  readonly reflect: number;
  /** The contact shadow; gone in dark, where the house elevation goes flat. */
  readonly shadow: number;
};

/** sRGB bytes (0..255) to linear light. */
export const linearOf = (bytes: readonly [number, number, number]): Rgb =>
  [bytes[0], bytes[1], bytes[2]].map((b) => Math.pow(b / 255, 2.2)) as unknown as Rgb;

/** Whether a page colour, in linear light, is a dark theme's. */
export const isDarkPage = (floor: Rgb): boolean => 0.2126 * floor[0] + 0.7152 * floor[1] + 0.0722 * floor[2] < 0.18;

/** The numbers each theme's studio uses; colours come from tokens, these from here. */
export const studioGains = (dark: boolean): Pick<Studio, 'keyGain' | 'pageGain' | 'reflect' | 'shadow'> =>
  dark ? { keyGain: 2.2, pageGain: 1.15, reflect: 0.6, shadow: 0 } : { keyGain: 2.2, pageGain: 1, reflect: 0.86, shadow: 0.2 };

const TOKENS = ['--metal-sky', '--metal-room', '--metal-warm', '--metal-flag', '--metal-rim', '--metal-key', '--background'] as const;

/**
 * Reads the studio from the document's current theme, or, given a `color-scheme`, from that
 * scheme's tokens: an orb on a surface darker than its page (the spine) is lit as on a dark page.
 */
export const readStudio = (doc: Document, colorScheme?: string): Studio => {
  const probe = doc.createElement('span');
  probe.style.display = 'none';
  if (colorScheme !== undefined) probe.style.colorScheme = colorScheme;
  doc.body.appendChild(probe);
  const pixel = doc.createElement('canvas');
  pixel.width = 1;
  pixel.height = 1;
  const ctx = pixel.getContext('2d', { willReadFrequently: true });
  const read = (token: string): Rgb => {
    probe.style.color = `var(${token})`;
    const css = doc.defaultView?.getComputedStyle(probe).color ?? '#000';
    if (ctx === null) return [0, 0, 0];
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0] = ctx.getImageData(0, 0, 1, 1).data;
    return linearOf([r, g, b]);
  };
  const [sky, room, warm, flag, rim, key, floor] = TOKENS.map(read) as unknown as readonly [Rgb, Rgb, Rgb, Rgb, Rgb, Rgb, Rgb];
  probe.remove();
  return { sky, room, warm, flag, rim, key, floor, ...studioGains(isDarkPage(floor)) };
};
