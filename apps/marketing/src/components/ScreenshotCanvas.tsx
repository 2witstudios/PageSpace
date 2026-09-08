"use client";

import Image from "next/image";
import { cn } from "@/lib/utils";
import { CANVAS, type ShotDevice } from "@/lib/app-store-shots";

interface ScreenshotCanvasProps {
  children: React.ReactNode;
  size: ShotDevice;
  className?: string;
  id?: string;
}

/**
 * The scrim over the backdrop. Vertical here rather than the landing page's
 * horizontal sweep, because a store screenshot stacks copy above the device
 * instead of setting them side by side — but the same ink (rgba(1,3,5,·)) and
 * the same blue glow, so the two read as one system.
 */
const SCRIM =
  "linear-gradient(180deg, rgba(1,3,5,0.78) 0%, rgba(1,3,5,0.45) 34%, rgba(1,3,5,0.25) 58%, rgba(1,3,5,0.85) 100%), " +
  "radial-gradient(ellipse 62% 34% at 50% -4%, rgba(59,130,246,0.14), rgba(1,3,5,0))";

export function ScreenshotCanvas({
  children,
  size,
  className,
  id = "screenshot",
}: ScreenshotCanvasProps) {
  const { width: finalWidth, height: finalHeight } = CANVAS[size];

  return (
    <div
      id={id}
      className={cn("relative overflow-hidden", className)}
      style={{
        width: finalWidth,
        height: finalHeight,
        // Matches the image's edge, so pre-paint and any letterboxing are the
        // same black the landing hero sits on.
        background: "#010305",
      }}
      data-screenshot="true"
      data-width={finalWidth}
      data-height={finalHeight}
    >
      <Image
        src="/hero-space.webp"
        alt=""
        fill
        priority
        quality={90}
        sizes={`${finalWidth}px`}
        style={{ objectFit: "cover", objectPosition: "50% 50%", zIndex: 0 }}
      />
      <div className="absolute inset-0 z-[1] pointer-events-none" style={{ background: SCRIM }} />
      <div className="absolute inset-0 z-[2]">{children}</div>
    </div>
  );
}

interface HeadlineProps {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * Same face and weight as the landing `h1.hero-h` — Newsreader at 500 with
 * -0.02em tracking — rather than the bold sans this used to be, so the store
 * listing and the site do not look like two different products.
 */
export function Headline({ children, className }: HeadlineProps) {
  return (
    <h1
      className={cn("text-[132px] leading-[0.98] text-white", className)}
      style={{
        fontFamily: "var(--font-display)",
        fontOpticalSizing: "auto",
        fontWeight: 500,
        letterSpacing: "-0.02em",
        textWrap: "balance",
      }}
    >
      {children}
    </h1>
  );
}

export function Subline({ children, className, style }: HeadlineProps) {
  return (
    <p
      className={cn("text-[46px] leading-[1.4]", className)}
      style={{ color: "rgba(255,255,255,0.88)", textWrap: "pretty", ...style }}
    >
      {children}
    </p>
  );
}

interface TagProps {
  children: React.ReactNode;
  className?: string;
}

export function Tag({ children, className }: TagProps) {
  return (
    <span
      className={cn(
        "inline-block px-8 py-4 rounded-full text-[26px] font-medium",
        "border border-white/15 bg-white/10 text-white/75 backdrop-blur-sm",
        className,
      )}
    >
      {children}
    </span>
  );
}
