// The world Imago's orb reflects at its edge (docs/imago/liquid-metal-engine.md §D2). A page
// cannot read its own pixels, so the engine paints a stand-in of the viewport at quarter scale
// from layout and colour: the shell's regions (its `data-slot`s, or anything marked
// `data-metal-env`) as filled rounded rects, and the text in its columns as one bar per line
// box. At orb scale the reflection is compressed and blurred, so structure, tone and the accent
// survive; glyphs would only shimmer.

export const WORLD_SCALE = 0.25;

/** Surfaces: the shell's slots and the parts inside them that mark themselves. */
export const ENV_SELECTOR = '[data-slot], [data-metal-env]';
/** Text: the columns' content, painted as line bars. */
export const INK_SELECTOR = '[data-slot="list"], [data-slot="object"], [data-slot="chat"], [data-slot="empty"], [data-metal-ink]';

const hasAlpha = (css: string): boolean => css !== 'transparent' && !/rgba\([^)]*,\s*0\)$/.test(css);

/** Repaints `world` from the document; returns false when it has no 2D context. */
export const paintWorld = (world: HTMLCanvasElement, doc: Document): boolean => {
  const view = doc.defaultView;
  const ctx = world.getContext('2d');
  if (view === null || ctx === null) return false;
  const width = Math.max(8, Math.ceil(view.innerWidth * WORLD_SCALE));
  const height = Math.max(8, Math.ceil(view.innerHeight * WORLD_SCALE));
  if (world.width !== width || world.height !== height) {
    world.width = width;
    world.height = height;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = view.getComputedStyle(doc.body).backgroundColor;
  ctx.fillRect(0, 0, width, height);
  ctx.setTransform(WORLD_SCALE, 0, 0, WORLD_SCALE, 0, 0);
  const visible = (rect: DOMRect) => rect.width > 0 && rect.bottom >= 0 && rect.top <= view.innerHeight;

  for (const el of doc.querySelectorAll<HTMLElement>(ENV_SELECTOR)) {
    const rect = el.getBoundingClientRect();
    const style = view.getComputedStyle(el);
    if (!visible(rect) || !hasAlpha(style.backgroundColor)) continue;
    ctx.fillStyle = style.backgroundColor;
    ctx.beginPath();
    ctx.roundRect(rect.left, rect.top, rect.width, rect.height, parseFloat(style.borderTopLeftRadius) || 0);
    ctx.fill();
  }

  const range = doc.createRange();
  for (const root of doc.querySelectorAll<HTMLElement>(INK_SELECTOR)) {
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const host = node.parentElement;
      if (host === null || !node.nodeValue?.trim() || host.closest('canvas,textarea,[data-metal-skip]') !== null) continue;
      ctx.fillStyle = view.getComputedStyle(host).color;
      ctx.globalAlpha = 0.55;
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        if (!visible(rect)) continue;
        const bar = rect.height * 0.5;
        ctx.fillRect(rect.left, rect.top + (rect.height - bar) / 2, rect.width, bar);
      }
      ctx.globalAlpha = 1;
    }
  }
  return true;
};
