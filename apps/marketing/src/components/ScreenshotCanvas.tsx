"use client";

import { cn } from "@/lib/utils";

type ScreenshotSize = "iphone" | "ipad" | "custom";

interface ScreenshotCanvasProps {
  children: React.ReactNode;
  size?: ScreenshotSize;
  width?: number;
  height?: number;
  background?: string;
  className?: string;
  id?: string;
}

const sizeConfigs = {
  iphone: { width: 1320, height: 2868 },
  ipad: { width: 2064, height: 2752 },
  custom: { width: 1920, height: 1080 },
} as const;

export function ScreenshotCanvas({
  children,
  size = "iphone",
  width,
  height,
  background = "bg-background",
  className,
  id = "screenshot",
}: ScreenshotCanvasProps) {
  const config = sizeConfigs[size];
  const finalWidth = width ?? config.width;
  const finalHeight = height ?? config.height;

  return (
    <div
      id={id}
      className={cn(
        "relative overflow-hidden",
        background,
        className
      )}
      style={{
        width: finalWidth,
        height: finalHeight,
      }}
      data-screenshot="true"
      data-width={finalWidth}
      data-height={finalHeight}
    >
      {children}
    </div>
  );
}

interface HeadlineProps {
  children: React.ReactNode;
  className?: string;
}

export function Headline({ children, className }: HeadlineProps) {
  return (
    <h1 className={cn(
      "text-[120px] font-bold text-foreground tracking-tight leading-[0.95]",
      className
    )}>
      {children}
    </h1>
  );
}

export function Subline({ children, className }: HeadlineProps) {
  return (
    <p className={cn(
      "text-4xl text-muted-foreground leading-relaxed",
      className
    )}>
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
    <span className={cn(
      "inline-block px-6 py-3 rounded-full",
      "text-lg font-medium",
      "bg-foreground/5 text-foreground/70",
      className
    )}>
      {children}
    </span>
  );
}
