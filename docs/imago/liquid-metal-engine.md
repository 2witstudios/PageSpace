# Imago Liquid Metal — design

- **Status:** Implemented in `apps/imago/src/ui/metal` (the confirmed prototype, ported)
- **Date:** 2026-10-18
- **Prototype:** `prototypes/imago-liquid-metal/index.html` (one file, WebGL2, no dependencies)
- **Related:** ADR 0007 (Imago app, token-locked design system), `apps/imago/src/app/globals.css` (tokens), `apps/imago/src/ui/chat/use-agent-chat` (`AgentTurnStatus`)

## 1. What we are making

Imago is represented by an orb of liquid metal: a living, polished mirror. It stays one round body, and its surface swells, ripples and settles while the agent listens, thinks and speaks. *Imago* is Latin for image, likeness, or reflection, so the material is the name. Imago has no colour of its own. Everything it shows is reflected from the person's work around it.

The reference concept is Apple's Liquid Glass, taken as a visual idea rather than a material to copy:

| Liquid Glass | Liquid Metal (this design) |
|---|---|
| Transmissive lens: bends what is **behind** it | Opaque mirror: shows what is **around and in front of** it |
| Lensing concentrates at the edges, where content is most bent | Reflection compresses at the rim, where the surrounding UI is most squeezed |
| Specular highlights move with device tilt | The studio key light moves with tilt (phone) or the pointer (desktop) |
| Shapes merge and separate like droplets (`GlassEffectContainer`, union) | One orb. Bulges well up from inside and travel under the surface, joined by a smooth-min signed distance field, and never detach |
| Gel-like flex on touch, illuminates from the touch point | Underdamped springs (gel overshoot); a press squashes and sends a ripple |
| Adapts its tint to light/dark content behind it | Adapts its studio to the theme, and keeps a contrast floor on any page |

## 2. Why this is hard

A mirror on a flat screen breaks most of the assumptions that make a mirror read as a mirror. Each problem below has a decision in §3.

1. **The front of a mirror shows the viewer, and a screen cannot see the viewer.** Seen head-on, most of a convex mirror's face reflects what is in front of it. On a screen, that is the person, which the screen does not know.
2. **Browsers do not let you read DOM pixels.** Liquid Glass on the web gets by because `backdrop-filter` hands the effect the pixels *behind* the element. A mirror needs the pixels *around* it, and no shipping API provides them (see §5.2).
3. **A mirror in a uniform room disappears.** Chrome in a white room is white. Imago's chat column is one flat neutral, so a physically honest mirror vanishes into it in light mode and turns into a black hole in dark mode.
4. **Reflections of text shimmer.** Glyphs compressed 10–50× and swept by motion alias into noise.
5. **Feedback.** The blob sits inside the chat it reflects, and messages stream in under it. The reflection must not include itself, and it must not cost a full re-render for each token.
6. **Scale.** The same character must read at 200px (empty chat), 28px (chat header) and 18px (inline "thinking" glyph).
7. **Budget.** It lives in the always-mounted shell (ADR 0007 §4), so it runs for the whole session, on Capacitor WebViews too.

## 3. Decisions

### D1. Three-zone optics: studio, flag, page

Imago is viewed orthographically from above, as a chrome ball resting on the page is seen from a camera overhead. For a surface normal `n` and view ray `V = (0,0,-1)`, the reflected ray is `R = V − 2(V·n)n`, so `R.z = 2·n.z² − 1`. That gives three zones that come straight from the geometry:

| Zone | Where | `R` | What it reflects |
|---|---|---|---|
| **Face** | centre | points at the viewer (`R.z > 0`) | **The studio:** a chrome studio standing in for the viewer's room (D3): bright sky over dark ground, split by a sharp horizon that arcs across the face |
| **Flag** | a ring, `R.z ∈ ~[−0.3, 0.3]` | near grazing | **A flag:** the black card product photographers set at the horizon to give chrome an edge |
| **Rim** | outer edge, `R.z < ~−0.3` | back toward the page | **The page:** the ray is intersected with the page plane `z=0` at `q = P.xy + R.xy · (P.z / −R.z)` and samples the interface there |

The rim does for Imago what lensing does for Liquid Glass. The interface around the blob slides across its edge, compressed toward the silhouette. Panes, the blue accent, the send button and the text lines of the open page all show up in it. It is a convex mirror, so things on the left appear on the left rim.

Two corrections keep this readable:

- **Contact occlusion.** The page directly under the blob lies in the blob's own shadow, so page samples near contact are darkened by `smoothstep(sdf(q))` (down to 18%). This gives the dark contact ring real chrome has, and it is what keeps the blob visible on a page of one flat colour.
- **A finite page.** Grazing rays travel far (`t → ∞`). Past about 1.5–3 orb units the page fades into the studio's **rim light**, which draws the silhouette: a dark edge on a light page, a bright strip on a dark one. Without it the edge dissolves.

The page is confined to the outer edge (from `R.z ≈ −0.3` out) rather than the whole `R.z < 0` band. Physically the band starts at `n.z < 0.707`, but on a page of one flat colour that band (about 29% of the radius) reads as a translucent glass shell around a dark ball. Kept to the edge, the page shows as a compressed sliver of the interface, and the flag holds the form inside it.

**Material and finish.** These are what make it read as liquid chrome rather than a polished pearl:

- **Polished silver:** Schlick Fresnel with `F0 ≈ (0.96, 0.955, 0.94)`, plus cheap SDF ambient occlusion where bulges meet.
- **Folds (D5):** fine creases that bend the reflections hard.
- **Dispersion:** the environment is sampled three times, with the normal spread outward for red and inward for blue in proportion to `1 − n.z`. That gives the thin colour fringe chrome photographs carry at the edges, the effect Paper's LiquidMetal exposes as `shiftRed`/`shiftBlue`.
- **Filmic tone curve (ACES fit):** keeps the blacks deep and rolls off the highlights. Chrome is mostly near-black next to near-white, with few midtones.
- **Sharp reflections:** mirror reflections are not blurred by default. Roughness ("polish") is reserved for the error mood's tarnish. It widens the light edges and raises the page's mip level.

### D2. The world: a proxy painted from layout and tokens, not a screenshot

The engine keeps one low-resolution **world texture** of the viewport (¼ scale), painted in Canvas 2D from what the shell already knows:

- elements marked `data-metal-env` are painted as rounded rects in their computed background colour (panes, rail, cards, chips, swatches, the composer);
- text inside `data-metal-ink` roots is painted as **one bar per line box** (`Range.getClientRects()`), in the text's own colour at about 55% to stand in for glyph coverage;
- `<canvas>` (Imago itself) and `<textarea>` are skipped, so there is no feedback loop.

At blob scale the reflected surround is compressed 10–50× and blurred by the mip chain, so what survives is structure, tone and accent. Glyphs would only alias (§2.4), so line bars are better than a screenshot, not just cheaper. A screenshot also costs more and would need consent.

**Repaint triggers:** resize, theme change, scroll (capture phase), a `MutationObserver` on the shell (debounced to one paint per frame), and `document.fonts.ready`. Cost: about 1–2ms on CPU at ¼ scale. While a reply streams, repaints are throttled to 10/s.

### D3. The studio is a theme token set, and the rim light is always the page's opposite

The face reflects a studio defined as tokens beside the existing ones, so the theme switch restyles Imago with no code path of its own:

```css
--metal-sky:   light-dark(oklch(0.96 0.008 240), oklch(0.74 0.012 240)); /* cool sky above the horizon */
--metal-room:  light-dark(oklch(0.5 0.008 250), oklch(0.38 0.006 250));  /* gunmetal ground below it */
--metal-warm:  light-dark(oklch(0.62 0.075 55), oklch(0.52 0.075 55));   /* copper glow just under the horizon */
--metal-flag:  light-dark(oklch(0.14 0.005 240), oklch(0.07 0 0));       /* black card at grazing */
--metal-rim:   light-dark(oklch(0.22 0.01 230), oklch(0.78 0.006 240));  /* silhouette light */
--metal-key:   light-dark(oklch(1 0 0), oklch(0.98 0.003 230));          /* softboxes */
/* numbers, per theme: key gain 2.2 / 2.2; page gain 1 / 1.15; contact shadow .2 / 0 */
```

**Revision (as prototyped now): designed bands, not a photographed room.** The app is mostly flat panes and white space, so a true mirror reflects light and little else. A reflective studio (a horizon, a floor, softboxes) still read as a mirror ball rather than liquid metal. The face now reflects a designed field instead, as Paper's LiquidMetal shader does:

- **Bands:** broad flowing light/dark bands (`fract(dot(R, dir) · 1.35 − t·0.045)`) through a chrome ramp, with a broad bright band, a thin bright line and a dark gunmetal floor between them.
- **Folds:** the folds bend the bands, and each colour channel is a little out of phase, which leaves thin colour fringes where bands meet.
- **Copper:** a copper glow sits in the dip after each bright band.
- **Lights:** the pointer-following key and one tall strip light remain, so light still moves across it.
- **Material:** polished metal with a slight satin finish, its reflectance a theme token (`--metal-reflect`), rising to white at the edges by Fresnel. Dark mode uses 0.6, a steel body that does not read as clear. Light mode uses 0.86 with deeper darks (`--metal-room` 0.3), because at 0.6 the bright bands came out mid-gray and the orb looked faded against a white page instead of silver.
- **The page:** it only tints the outer edge, at 30%.

The horizon studio below is what that revision replaced. It is kept here for the record:

- **Horizon:** a sharp horizon arcs across the face (elevation `R.y + 0.38·(1 − R.z) − 0.1`). Above it is a cool sky with faint banding; below it is gunmetal ground with seams and a pool of light. A thin bright glint runs along the horizon line.
- **Copper:** a narrow copper glow sits just under the horizon. It is what fills the folds' recesses, as in the reference images, without browning the whole lower half.
- **Lights:** three hard-edged softboxes. The key follows the pointer, and two tall strips stand at the sides. Their curved glints across the face are the strongest chrome cue.

What makes both themes work:

- **The rim light is the opposite of the page.** On a light page a dark edge outlines the orb. On a dark page a crisp bright strip does, as in dark product photography of chrome.
- **The flag stays dark in both themes**, so the face and the rim always have a dark band between them. That band is what reads as a curved, polished surface.
- **Dark mode lifts the page reflection** (page gain 1.15). This is not physical, but dark pages carry so little tone that an honest reflection is black on black. The prototype went through three versions:
  1. A black ball with no edge.
  2. A light flag, which gave a flat, blurry gray band.
  3. The split above: a dark flag plus a bright rim light.

  Version 3 is the first that keeps the sphere readable in dark mode.

The engine resolves tokens by setting them as a hidden probe's `color` (custom properties come back from `getComputedStyle` unresolved, and `light-dark()` resolves only through a real property), then reading the bytes from a 1px canvas. This holds to the token-locked rule (ADR 0007 §4): there are no literal colours in the engine.

### D4. The viewer's side of the mirror

The studio's **key light follows device tilt** (`DeviceOrientationEvent`, after a permission prompt on iOS) on phones, and the **pointer** on desktop. That is Liquid Glass's tilt-tracked specular, and it is what makes the mirror feel present in the room.

**Optional: a true mirror.** With explicit, per-session consent, the front camera could feed the studio map, so Imago would literally show the viewer: blurred, low-resolution, processed on the device and never uploaded. It is the strongest expression of the name and also the riskiest privacy surface we would add. It is off by default and **not in v1** (see §10).

### D5. The body: one orb with liquid on its surface, on gel springs

The first prototype orbited separate droplets around a core. In idle they read as limbs: a starfish, not an orb. The body is now **one orb**, and every liquid behaviour happens on or just under its surface:

- **Orb:** a sphere (radius ≈ 0.54 of the view's half-width), ray-marched in a single fragment shader (72 steps max, orthographic).
- **Surface modes:** smooth low-order polynomial modes on the unit direction from the centre: a quadrupole (`x²−y²`, `2xy`), an octupole (`x³−3xy²`, `3x²y−y³`), and a `z·x`/`z·y` term, each rotating slowly. Together they make the surface swell and settle like a drop of mercury. They are polynomials because an angle-based (`atan`) mode pinches at the pole facing the viewer, which showed up as a visible "+" in the face.
- **Bulges:** 1–3 droplets *inside* the orb, each on a tilted great circle at `core − r + swell`, so they push the surface out by `swell` (0–0.06) as they travel. They are joined with polynomial smooth-min (`k` ≈ 0.22–0.26) and kept off the hidden underside. They never leave the orb.
- **Folds:** fine creases from domain-warped waves. The position is warped twice by sine fields that drift at different rates, then a product of sines is subtracted from the distance (amplitude `0.021 + churn·0.2`). They barely change the silhouette but bend every reflection, and that bending is most of what reads as liquid. The mood's churn deepens them: thinking churns hardest.
- **Pulse:** a decaying radial ripple across the face, sent by each streamed token and by touch.
- **Ray march:** the folds need finer marching, at 110 steps and a step factor of 0.75. The cost on real devices has not been profiled yet.
- **Motion:** every parameter chases its mood target on an **underdamped spring** (stiffness 90, damping 11, ζ ≈ 0.58). That overshoot is the gel feel. Orbits advance by integrating phase (`phase += speed·dt`), so a change of speed never makes the droplets jump.
- **Gaze:** the orb barely moves. It leans by swinging its first bulge toward what it attends to (the pointer within about 420px, the composer while listening) and swelling it, so attention reads as the surface reaching out.
- **Touch:** pressing the hero squashes it (spring velocity impulse) and sends a pulse, like Liquid Glass's flex on touch.
- **Silhouette anti-aliasing:** on a miss, the closest approach along the ray (`minD`, `pMin`) is shaded with coverage `1 − smoothstep(0, ~1.3px, minD)`. That gives clean edges at 18px without supersampling.

### D6. Moods, derived from state that already exists

The mood comes from a pure function of state Imago already has. The engine never invents state.

```ts
type ImagoMood = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error';
moodFor({ status, composerFocused }: { status: AgentTurnStatus; composerFocused: boolean }): ImagoMood
// 'error' → error · 'submitted' → thinking · 'streaming' → speaking
// 'ready' + composer focused → listening · otherwise idle
```

| Mood | Body | Orb / bulge / swell | Bulge speed | Wobble | Churn | Other |
|---|---|---|---|---|---|---|
| idle | slow breathing, the surface swells and settles | .54 / .22 / .045 | .22 | .020 | .02 | breathe 2.2% |
| listening | goes still and reaches toward the composer | .55 / .24 / .025 | .10 | .010 | .01 | lean .12, slightly taller |
| thinking | currents race under the surface | .52 / .22 / .06 | 1.2 | .036 | .07 | |
| speaking | ripples on each streamed token | .54 / .20 / .05 | .45 | .022 | .04 | pulse += .32 per token |
| error | sags, stills, tarnishes | .52 / .16 / 0 | .04 | .004 | 0 | roughness .45, dim .4, squash .86 |

Typing in the composer adds a small pulse per keystroke, so Imago visibly takes in the words. Mood is never the only signal: the status text stays in an `aria-live` region (§8).

### D7. Size classes

| Class | Where | Bulges | Wobble / churn / pulse | Contact shadow |
|---|---|---|---|---|
| `hero` (≈200px) | empty chat, Imago home | 3 | full | yes (light mode) |
| `avatar` (≈28px) | chat header, agent picker, ask pill | 2 | full / half / yes | faint |
| `glyph` (≈18px) | inline in a streaming message | 1 | half / none / none | none |

A glyph cannot carry choreography, so it carries only mood: swell, speed and tarnish.

## 4. Architecture in `apps/imago` (as built)

One engine, many views. Browsers cap live WebGL contexts at about 16 and destroy the oldest when a page goes over, so a context per orb would fail in a long session.

```
apps/imago/src/ui/metal/
  metal-mood.ts           pure: MOODS, moodFor(), detailFor() size classes           (unit-tested)
  metal-springs.ts        pure: makeSprings(), stepSprings(), kick(), orbBalls()    (unit-tested)
  metal-shader.ts         the confirmed GLSL, verbatim from the prototype
  metal-studio.ts         token probe → linear-RGB studio; per-theme gains           (pure parts tested)
  metal-world.ts          DOM → quarter-scale world texture
  metal-engine.ts         singleton: one WebGL2 context, view registry, rAF loop, context loss
  imago-orb/              <ImagoOrb size live? label?>: container, render, class (exact-string tested)
  page-icon.tsx           renderPageIcon(): a page's icon, or Imago's orb for Imago's page
  imago-thread.tsx        context: is this chat Imago's own (its thinking glyph is the orb)
  author-avatar.tsx       an agent post's face: Imago posts as its orb
```

- **Rendering:** one offscreen WebGL2 canvas. For each visible view the engine sets the viewport to the view's device-pixel size, draws, then `drawImage`s the region into that view's own 2D canvas in the same task. Views therefore stay in normal DOM flow, z-order and clipping (popovers cover them correctly), unlike a full-screen overlay canvas.
- **Views:**
  - **live:** draws every frame with Imago's mood.
  - **still:** draws once, and again on a theme or size change. On hover (`pointerenter` on its parent) it animates for 1.4s and settles.
  - The loop runs only while a visible view needs frames. It stops when the tab is hidden, and `IntersectionObserver` skips views offscreen.
- **Mood:** `moodFor()` reads two things outside React:
  - `streamingPhase`, a chat-slice resource. The retained `StreamingBridge` sets it to thinking while a send is pending and speaking once the viewer's own stream runs.
  - Whether a text field inside `[data-imago-chat]` has focus. `RetainedChat` marks Imago's own chat that way.
- **Tokens:** the `--metal-*` colours are `light-dark()` pairs on `:root` in `globals.css`. The per-theme numbers (key gain, page gain, reflectance, contact shadow) live in `studioGains()`, because `:root` only holds colours. The sizes are `--spacing-orb-hero` (120px) and `--spacing-orb-glyph` (16px), plus the existing agent tile, picker row and avatar sizes. Without WebGL2, the `orb-chrome` utility draws a still chrome ball from the same tokens.
- **Marking the world:** the painter reads the shell's existing `data-slot` regions (rail, stage, list, object, chat, empty) as surfaces and their columns' text as line bars, so no markup changed. Anything else can opt in with `data-metal-env` or `data-metal-ink`, or opt out with `data-metal-skip`.
- **Coordinates:** each view passes its viewport rect, so its edge reflection samples the world at its true position.
- **Context loss:** the engine handles `webglcontextlost` and `webglcontextrestored`. Views fall back to the still chrome until the context is restored.

## 4a. Where Imago appears

| Tier | Where | Size |
|---|---|---|
| **Live** (moves with Imago's mood) | Chat head picker trigger while Imago is talking | `tile` (22px) |
| | Imago's empty chat (Home welcome), above the Home line | `hero` (120px) |
| | Thinking indicator in Imago's own thread (other agents keep the spinner) | `glyph` (16px) |
| | Ask pill, empty-middle "Ask Imago", phone Ask | `glyph` |
| **Still** (alive on hover) | Rail's Chat button | `tile` |
| | Left sidebar tree row for Imago's page | the row's 16px |
| | Imago's row in the agent picker | `row` (30px) |
| | Tabs, phone open pages, favorites and recents, empty-middle recents, files browser, ⌘K results | `glyph` (`row` in the browser's grid) |
| | Imago's own posts in channels | `avatar` (28px) |

User agents keep the sparkle and the agent hue. Only Imago is metal. The picker now marks Imago's row by the agent itself (`AgentOption.imago`) rather than by being the first group, so a drive with no built-in agents no longer gives its first agent Imago's tile.

## 5. Environment capture: options considered

### 5.1 Chosen: the proxy painter (D2)

It works in every engine, costs about 1–2ms per repaint, is theme-correct by construction, has no privacy surface, and is what you would want visually at this scale anyway.

### 5.2 Rejected for now

- **HTML-in-Canvas** (`drawElementImage` / `texElementSubImage2D`, attribute `layoutsubtree` → `content="drawable"`). It can only draw **descendants of the canvas**, so it cannot see the shell around Imago unless the shell lives inside a canvas. It is also still behind a flag or origin trial in Chromium only. Revisit if it gains a way to draw arbitrary elements. It would then replace the painter behind the same world-texture interface.
- **`backdrop-filter: url(#svg)` + `feDisplacementMap`.** This is how web Liquid Glass demos work. It is Chromium-only, it can only see pixels *behind* the element's own box (a mirror needs the surround, so the box would have to be inflated and masked), and the displacement map would need regenerating every frame as the blob morphs.
- **DOM rasterisation (html2canvas-style).** 50–300ms per capture, unreliable with cross-origin images and backdrop filters, and it would put glyph detail into the reflection that we would then have to blur away.
- **`-moz-element()`.** Firefox only.

## 6. Performance budget

| Item | Budget |
|---|---|
| GPU per hero frame (400², 4 droplets) | ≤ 1ms on integrated GPUs |
| World repaint (CPU) | ≤ 2ms; at most one per frame, 10/s while streaming |
| Frame rate | 60fps while the mood is changing or the pointer is near; drops to 20fps after 3s of idle; stops when the view is offscreen (`IntersectionObserver`) or the document is hidden |
| Device pixel ratio | capped at 2 |
| Memory | one context, one world texture (¼ viewport, with mips) |

## 7. Motion and reduced motion

- `prefers-reduced-motion: reduce`: no ambient motion (no orbit, breathing, churn or pulses). Mood changes jump to their targets, and the blob re-renders only when the mood, theme or layout changes. A still mirror is still a mirror, and the reflections stay correct.
- The motion curve for anything outside the engine stays `--ease-pane`.

## 8. Accessibility and fallbacks

- `role="img"` with `aria-label="Imago"`. The state is always also in text (the existing status line, `aria-live="polite"`). Mood is decoration, never the only signal.
- When the blob is a control (the ask pill), the button wrapping it carries the focus halo. The canvas is never focusable itself.
- **No WebGL2 / context lost:** a still chrome made from a CSS radial gradient of the same `--metal-*` tokens (key spot, sky, room, flag ring). It is honest and theme-correct, and it does not move.
- `prefers-reduced-transparency` does not apply: the metal is opaque.

## 9. What the prototype established

- **The three-zone model works.** The rim visibly carries the open page's accent, swatches and text bars, and shifts as the blob moves or the layout changes.
- **The washout is real, and occlusion plus a finite page fix it.** The first pass was a pale blob on the pale chat column. Contact occlusion and fading the far page into the flag gave it a chrome silhouette with no colour of its own.
- **Dark mode needs its own studio.** The dark-mode blob went from a black hole, to a flat gray band, to a dark chrome body with a crisp bright rim (D3).
- **Separate droplets read as a starfish.** One orb with surface modes and internal bulges reads as liquid metal and keeps the sphere (D5).
- **A soft studio reads as pearl, not metal.** The first studio (a soft gradient with round softboxes, blurred by mips) gave a pale, low-contrast orb. Liquid metal needs:
  - a hard horizon, hard-edged lights and sharp reflections;
  - fine folds that bend all of them;
  - deep blacks from a filmic curve;
  - a trace of dispersion at the edges.

  With those (D1, D3), the orb matches the reference look: chrome, warped horizon, strip glints and copper in the recesses.
- **One shared context with blits per view** renders three simultaneous views (hero, avatar, inline glyph) without errors, even in headless Chromium on SwiftShader (software GL). It has not yet been profiled on real devices.

## 10. Open questions for the owner

1. **True mirror (camera):** ship it later as an opt-in, or never? (D4)
2. **Pure silver or a trace of blue?** The design keeps the metal neutral so the accent appears only by reflection, which follows "the accent is the only colour". A faint blue in `F0` would tie Imago to the brand but stop it being a mirror.
3. **Where it appears in v1:** hero and avatar only, or also the inline glyph and the collapsed ask pill?
4. **Does Imago reflect other agents?** In a side chat with another agent, should Imago's avatar still be metal, and do user agents get a material of their own?
5. **Mood vocabulary:** do we need more moods (`waiting on you` for `ask_user`, `working` for long tool runs) beyond the five turn states?

## 11. Rollout

1. Done: pure modules and tests, tokens, engine, `<ImagoOrb>`, and every surface in §4a. It ships with Imago itself, behind `IMAGO_ENABLED` and with no flag of its own.
2. Next: a performance pass on real devices, including the Capacitor iOS and Android WebViews. It has so far only been rendered in headless Chromium on software GL.
