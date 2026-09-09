import Image from "next/image";
import { FRAME, type ShotDevice } from "@/lib/app-store-shots";

/**
 * A screenshot inside Apple's official product bezel.
 *
 * Layered, back to front: ambient glow, the capture positioned into the bezel's
 * screen aperture, a glass sheen over that aperture, then the hardware art on
 * top. The wrapper is sized to the bezel PNG, so callers scale the whole
 * assembly rather than the bare screen.
 *
 * Note what does NOT work on this canvas: a dark drop shadow. The repo's
 * elevation tokens bottom out around rgb(0 0 0 / 0.24), which is invisible
 * against the #010305 starfield. What separates hardware from background here
 * is a light rim and a soft blue ambient — the same blue the landing hero and
 * the canvas scrim already use.
 */
export function DeviceOutline({
  children,
  device,
  className,
}: {
  children: React.ReactNode;
  device: ShotDevice;
  className?: string;
}) {
  const f = FRAME[device];

  return (
    <div className={className} style={{ position: "relative", width: f.width, height: f.height }}>
      {/* Ambient: a wide, soft halo so the device reads as lit rather than pasted on. */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: "-6%",
          background:
            "radial-gradient(ellipse 55% 45% at 50% 45%, rgba(59,130,246,0.20), rgba(1,3,5,0) 70%)",
          filter: "blur(60px)",
        }}
      />

      {/* The capture, dropped into the aperture. Both bezels happen to be exact
          1:1 matches for their capture, so nothing is resampled here. */}
      <div
        style={{
          position: "absolute",
          left: f.screen.x,
          top: f.screen.y,
          width: f.screen.w,
          height: f.screen.h,
          overflow: "hidden",
          borderRadius: f.screen.radius,
        }}
      >
        {children}
        {/* Glass sheen — a low diagonal wipe. Deliberately faint: it should read
            as light on glass, never as a gradient laid over the UI. */}
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            background:
              "linear-gradient(112deg, rgba(255,255,255,0.07) 0%, rgba(255,255,255,0.025) 18%, rgba(255,255,255,0) 42%)",
          }}
        />
      </div>

      {/* Apple's hardware art. `unoptimized` so it is not re-encoded — the
          marketing guidelines ask that the imagery not be altered. */}
      <Image
        src={f.src}
        alt=""
        width={f.width}
        height={f.height}
        unoptimized
        priority
        style={{ position: "absolute", inset: 0, width: f.width, height: f.height }}
      />
    </div>
  );
}

/**
 * The framed device plus its reflection.
 *
 * The reflection is a flipped copy fading downward. It is allowed to run past
 * the bottom of the canvas — `ScreenshotCanvas` is `overflow-hidden`, so it
 * clips there naturally, which means the reflection costs no layout space and
 * the device keeps its full size.
 */
export function DeviceWithReflection({
  children,
  device,
}: {
  children: React.ReactNode;
  device: ShotDevice;
}) {
  const f = FRAME[device];
  const frame = <DeviceOutline device={device}>{children}</DeviceOutline>;

  return (
    <div style={{ position: "relative", width: f.width, height: f.height }}>
      {frame}
      {/* The mask lives on the un-flipped wrapper so its coordinates stay in
          normal space, and the flip uses the default centre origin — with
          `top center` the mirrored copy renders upward, straight over the
          device it is meant to sit beneath. */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          top: f.height,
          left: 0,
          width: f.width,
          height: f.height,
          opacity: 0.16,
          overflow: "hidden",
          maskImage: "linear-gradient(to bottom, black 0%, transparent 45%)",
          WebkitMaskImage: "linear-gradient(to bottom, black 0%, transparent 45%)",
          pointerEvents: "none",
        }}
      >
        <div style={{ transform: "scaleY(-1)" }}>{frame}</div>
      </div>
    </div>
  );
}
