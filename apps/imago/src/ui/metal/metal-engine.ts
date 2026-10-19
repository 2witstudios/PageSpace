// Imago's liquid-metal engine (docs/imago/liquid-metal-engine.md §4). One WebGL2 context for every
// orb on screen: browsers cap live contexts and drop the oldest past it, so a context per orb would
// fail in a long session. Each orb is its own 2D canvas in normal flow (so popovers still cover
// it); the engine draws a view into the shared context and copies it across in the same task.
//
// Two kinds of view:
//   live  - every frame, moving with Imago's mood (the chat head, the empty chat, the thinking
//           glyph, the Ask buttons);
//   still - drawn once, and again on theme or size changes; on hover it comes alive for a moment
//           and settles (the rail, the tree, tabs and other lists).
// The loop runs only while some visible view needs frames, and stops when the tab is hidden.

import { getUiState, subscribeUiState } from '../store/store';
import { MOODS, detailFor, moodFor, type MetalMood } from './metal-mood';
import { kick, makeSprings, orbBalls, stepSprings, type Gaze, type Springs } from './metal-springs';
import { METAL_FRAGMENT_SHADER, METAL_UNIFORMS, METAL_VERTEX_SHADER, type MetalUniform } from './metal-shader';
import { readStudio, type Studio } from './metal-studio';
import { paintWorld } from './metal-world';

export type OrbMode = 'live' | 'still';

type View = {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly mode: OrbMode;
  readonly onLost: (lost: boolean) => void;
  springs: Springs;
  time: number;
  phase: number;
  pulse: number;
  gaze: Gaze;
  visible: boolean;
  /** Frames are owed until then: a hover, a press, or a still view's first draw. */
  aliveUntil: number;
  dirty: boolean;
};

/** How long a still orb stays alive after a hover, in ms. */
const HOVER_ALIVE = 1400;
/** The world repaints at most this often while live orbs are on screen, in ms. */
const WORLD_INTERVAL = 250;

class MetalEngine {
  private readonly glCanvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly world: HTMLCanvasElement;
  private readonly views = new Set<View>();
  private uniforms = {} as Record<MetalUniform, WebGLUniformLocation | null>;
  private worldTexture: WebGLTexture | null = null;
  private studio: Studio;
  private lost = false;
  private frame = 0;
  private last = 0;
  private worldDirty = true;
  private worldPaintedAt = -Infinity;
  private pointer: { x: number; y: number } | null = null;
  private key = { x: 0.35, y: 0.55 };
  private composerFocused = false;
  private mood: MetalMood = 'idle';
  private nextTokenPulse = 0;
  private readonly reduceMotion: MediaQueryList;
  private readonly observer: IntersectionObserver;

  static create(doc: Document): MetalEngine | null {
    const glCanvas = doc.createElement('canvas');
    const gl = glCanvas.getContext('webgl2', { premultipliedAlpha: true, alpha: true, antialias: false });
    if (gl === null) return null;
    try {
      return new MetalEngine(doc, glCanvas, gl);
    } catch {
      return null;
    }
  }

  private constructor(
    private readonly doc: Document,
    glCanvas: HTMLCanvasElement,
    gl: WebGL2RenderingContext,
  ) {
    this.glCanvas = glCanvas;
    this.gl = gl;
    this.world = doc.createElement('canvas');
    this.compile();
    this.studio = readStudio(doc);
    const win = doc.defaultView as Window;
    this.reduceMotion = win.matchMedia('(prefers-reduced-motion: reduce)');
    this.observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const view = this.viewOf(entry.target);
        if (view === undefined) continue;
        view.visible = entry.isIntersecting;
        if (view.visible) this.schedule();
      }
    });

    const markWorld = () => {
      this.worldDirty = true;
    };
    win.addEventListener('resize', () => this.restyle(false), { passive: true });
    win.addEventListener('scroll', markWorld, { passive: true, capture: true });
    win.addEventListener('pointermove', (event) => {
      this.pointer = { x: event.clientX, y: event.clientY };
    }, { passive: true });
    doc.addEventListener('pointerleave', () => {
      this.pointer = null;
    });
    doc.addEventListener('focusin', () => this.trackComposer());
    doc.addEventListener('focusout', () => queueMicrotask(() => this.trackComposer()));
    doc.addEventListener('visibilitychange', () => {
      if (!doc.hidden) this.schedule();
    });
    // Theme: the root's data-theme and the system scheme both restyle the studio.
    new MutationObserver(() => this.restyle(true)).observe(doc.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    win.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.restyle(true));
    new MutationObserver(markWorld).observe(doc.body, { subtree: true, childList: true, characterData: true });
    subscribeUiState(() => this.schedule());
    glCanvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      this.setLost(true);
    });
    glCanvas.addEventListener('webglcontextrestored', () => {
      this.compile();
      this.setLost(false);
    });
  }

  /** Registers an orb's canvas; returns the call that unregisters it. */
  register(canvas: HTMLCanvasElement, mode: OrbMode, onLost: (lost: boolean) => void): () => void {
    const ctx = canvas.getContext('2d');
    if (ctx === null) {
      onLost(true);
      return () => undefined;
    }
    const view: View = {
      canvas,
      ctx,
      mode,
      onLost,
      springs: makeSprings(MOODS.idle),
      time: Math.random() * 20,
      phase: Math.random() * 6,
      pulse: 0,
      gaze: { x: 0, y: 0 },
      visible: true,
      aliveUntil: 0,
      dirty: true,
    };
    const host = canvas.parentElement ?? canvas;
    const wake = () => {
      view.aliveUntil = performance.now() + HOVER_ALIVE;
      this.schedule();
    };
    const press = () => {
      view.springs = kick(kick(view.springs, 'squash', -4.2), 'core', 1.2);
      view.pulse = Math.min(1.2, view.pulse + 0.8);
      wake();
    };
    host.addEventListener('pointerenter', wake);
    canvas.addEventListener('pointerdown', press);
    this.views.add(view);
    this.observer.observe(canvas);
    if (this.lost) onLost(true);
    this.schedule();
    return () => {
      host.removeEventListener('pointerenter', wake);
      canvas.removeEventListener('pointerdown', press);
      this.observer.unobserve(canvas);
      this.views.delete(view);
    };
  }

  private viewOf(target: Element): View | undefined {
    for (const view of this.views) if (view.canvas === target) return view;
    return undefined;
  }

  private compile(): void {
    const gl = this.gl;
    const shader = (type: number, source: string) => {
      const s = gl.createShader(type);
      if (s === null) throw new Error('metal: no shader');
      gl.shaderSource(s, source);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'metal: compile failed');
      return s;
    };
    const program = gl.createProgram();
    gl.attachShader(program, shader(gl.VERTEX_SHADER, METAL_VERTEX_SHADER));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, METAL_FRAGMENT_SHADER));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'metal: link failed');
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'aPos');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    this.uniforms = Object.fromEntries(METAL_UNIFORMS.map((name) => [name, gl.getUniformLocation(program, name)])) as Record<
      MetalUniform,
      WebGLUniformLocation | null
    >;
    this.worldTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.worldTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.worldDirty = true;
  }

  private setLost(lost: boolean): void {
    this.lost = lost;
    for (const view of this.views) {
      view.onLost(lost);
      view.dirty = true;
    }
    if (!lost) this.schedule();
  }

  /** The theme or the viewport changed: re-read the studio when asked, and redraw everything. */
  private restyle(theme: boolean): void {
    if (theme) this.studio = readStudio(this.doc);
    this.worldDirty = true;
    for (const view of this.views) view.dirty = true;
    this.schedule();
  }

  /** The field the viewer is typing to Imago in, if any: a text field inside Imago's own chat. */
  private composer(): Element | null {
    const active = this.doc.activeElement;
    if (active === null || active.closest('[data-imago-chat]') === null) return null;
    return active.matches('textarea, input, [contenteditable="true"]') ? active : null;
  }

  private trackComposer(): void {
    const focused = this.composer() !== null;
    if (focused === this.composerFocused) return;
    this.composerFocused = focused;
    this.schedule();
  }

  private schedule(): void {
    if (this.frame !== 0 || this.lost) return;
    this.frame = requestAnimationFrame((now) => this.tick(now));
  }

  private tick(now: number): void {
    this.frame = 0;
    if (this.doc.hidden || this.lost) return;
    const dt = Math.min(1 / 30, this.last === 0 ? 1 / 60 : (now - this.last) / 1000);
    this.last = now;
    const still = this.reduceMotion.matches;
    const mood = moodFor({ phase: getUiState().resources.streamingPhase, composerFocused: this.composerFocused });
    if (mood !== this.mood) {
      this.mood = mood;
      for (const view of this.views) if (view.mode === 'live') view.dirty = true;
    }
    // Speaking ripples the surface as the reply arrives; never under reduced motion.
    if (!still && mood === 'speaking' && now >= this.nextTokenPulse) {
      for (const view of this.views) if (view.mode === 'live') view.pulse = Math.min(1.4, view.pulse + 0.32);
      this.nextTokenPulse = now + 70 + Math.random() * 110;
    }

    // The world is repainted only on a tick where some orb will draw; until then it stays dirty.
    const animates = (view: View) => !still && (view.mode === 'live' || now < view.aliveUntil);
    const drawing = [...this.views].some((view) => view.visible && (view.dirty || animates(view)));
    const live = [...this.views].some((view) => view.visible && view.mode === 'live');
    if (drawing && this.worldDirty && (now - this.worldPaintedAt >= WORLD_INTERVAL || !live)) {
      if (paintWorld(this.world, this.doc)) this.uploadWorld();
      this.worldDirty = false;
      this.worldPaintedAt = now;
    }

    const win = this.doc.defaultView as Window;
    const nx = this.pointer === null ? 0 : (this.pointer.x / win.innerWidth) * 2 - 1;
    const ny = this.pointer === null ? -0.3 : (this.pointer.y / win.innerHeight) * 2 - 1;
    const follow = Math.min(1, dt * 4);
    this.key = { x: this.key.x + (0.3 + nx * 0.55 - this.key.x) * follow, y: this.key.y + (0.5 - ny * 0.45 - this.key.y) * follow };

    let more = false;
    for (const view of this.views) {
      if (!view.visible) continue;
      const animating = animates(view);
      if (!animating && !view.dirty) continue;
      const targets = MOODS[view.mode === 'live' ? mood : 'idle'];
      view.springs = stepSprings(view.springs, targets, dt, still);
      if (animating) {
        view.time += dt;
        view.phase += dt * view.springs.speed.x;
        view.pulse *= Math.exp(-dt * 3.2);
        more = true;
      }
      // A view with no size yet (a hidden or collapsed container) stays owed a draw.
      if (this.render(view)) view.dirty = false;
    }
    if (more || (drawing && this.worldDirty)) this.schedule();
  }

  private uploadWorld(): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.worldTexture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, this.world);
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  /** Where the orb attends: the pointer when near, the composer while listening. */
  private gazeOf(rect: DOMRect): Gaze {
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const toward = (x: number, y: number, reach: number): Gaze => {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.hypot(dx, dy) || 1;
      const pull = Math.max(0, 1 - dist / reach);
      return { x: (dx / dist) * pull, y: (-dy / dist) * pull };
    };
    if (this.mood === 'listening') {
      const composer = this.composer()?.getBoundingClientRect();
      if (composer !== undefined) return toward(composer.left + composer.width / 2, composer.top + composer.height / 2, 1600);
    }
    return this.pointer === null ? { x: 0, y: 0 } : toward(this.pointer.x, this.pointer.y, 420);
  }

  /** Draws one view; false when it has no size to draw into yet. */
  private render(view: View): boolean {
    const { gl, uniforms: u, studio } = this;
    const rect = view.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const win = this.doc.defaultView as Window;
    const dpr = Math.min(2, win.devicePixelRatio || 1);
    const width = Math.round(rect.width * dpr);
    const height = Math.round(rect.height * dpr);
    if (view.canvas.width !== width || view.canvas.height !== height) {
      view.canvas.width = width;
      view.canvas.height = height;
    }
    if (this.glCanvas.width < width || this.glCanvas.height < height) {
      this.glCanvas.width = Math.max(this.glCanvas.width, width);
      this.glCanvas.height = Math.max(this.glCanvas.height, height);
    }
    const detail = detailFor(rect.width);
    const target = view.mode === 'live' || performance.now() < view.aliveUntil ? this.gazeOf(rect) : { x: 0, y: 0 };
    view.gaze = { x: view.gaze.x + (target.x - view.gaze.x) * 0.08, y: view.gaze.y + (target.y - view.gaze.y) * 0.08 };
    const s = view.springs;
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform2f(u.uRes, width, height);
    gl.uniform4f(u.uRect, rect.left, rect.top, rect.width, rect.height);
    gl.uniform2f(u.uViewport, win.innerWidth, win.innerHeight);
    gl.uniform1f(u.uScale, rect.width / 2);
    gl.uniform1i(u.uWorld, 0);
    gl.uniform4fv(u.uBalls, orbBalls({ springs: s, time: view.time, phase: view.phase, gaze: view.gaze, drops: detail.drops }));
    gl.uniform1i(u.uCount, detail.drops);
    gl.uniform1f(u.uK, s.k.x);
    gl.uniform1f(u.uChurn, s.churn.x * detail.churnScale);
    gl.uniform1f(u.uWobble, s.wobble.x * detail.wobbleScale);
    gl.uniform1f(u.uPulse, detail.pulses && !this.reduceMotion.matches ? view.pulse : 0);
    gl.uniform1f(u.uRough, 0);
    gl.uniform1f(u.uDim, 0);
    gl.uniform1f(u.uSquash, Math.max(0.5, s.squash.x));
    gl.uniform1f(u.uTime, view.time);
    gl.uniform1f(u.uShadow, rect.width >= 80 ? studio.shadow : 0);
    gl.uniform1f(u.uKeyGain, studio.keyGain);
    gl.uniform1f(u.uPageGain, studio.pageGain);
    gl.uniform1f(u.uReflect, studio.reflect);
    gl.uniform3f(u.uKeyDir, this.key.x, this.key.y, 0.8);
    gl.uniform3fv(u.uRoom, studio.room);
    gl.uniform3fv(u.uSky, studio.sky);
    gl.uniform3fv(u.uFlag, studio.flag);
    gl.uniform3fv(u.uWarm, studio.warm);
    gl.uniform3fv(u.uRim, studio.rim);
    gl.uniform3fv(u.uKey, studio.key);
    gl.uniform3fv(u.uFloor, studio.floor);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    view.ctx.clearRect(0, 0, width, height);
    view.ctx.drawImage(this.glCanvas, 0, this.glCanvas.height - height, width, height, 0, 0, width, height);
    return true;
  }
}

let engine: MetalEngine | null | undefined;

/** The page's one metal engine; null on the server, in tests, or without WebGL2. */
export const getMetalEngine = (): MetalEngine | null => {
  if (typeof window === 'undefined' || typeof IntersectionObserver === 'undefined') return null;
  if (engine === undefined) engine = MetalEngine.create(document);
  return engine;
};

export type { MetalEngine };
