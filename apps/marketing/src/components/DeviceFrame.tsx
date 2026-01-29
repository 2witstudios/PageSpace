"use client";

import { cn } from "@/lib/utils";

type DeviceType = "iphone" | "ipad";

interface DeviceOutlineProps {
  children: React.ReactNode;
  device?: DeviceType;
  className?: string;
}

const deviceConfigs = {
  iphone: {
    width: 1320,
    height: 2868,
    borderRadius: 140,
    strokeWidth: 8,
  },
  ipad: {
    width: 2064,
    height: 2752,
    borderRadius: 80,
    strokeWidth: 10,
  },
} as const;

export function DeviceOutline({
  children,
  device = "iphone",
  className,
}: DeviceOutlineProps) {
  const config = deviceConfigs[device];

  return (
    <div
      className={cn("relative", className)}
      style={{
        width: config.width,
        height: config.height,
      }}
    >
      {/* Content */}
      <div
        className="absolute inset-0 overflow-hidden"
        style={{
          borderRadius: config.borderRadius,
        }}
      >
        {children}
      </div>

      {/* Outline stroke */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          borderRadius: config.borderRadius,
          border: `${config.strokeWidth}px solid currentColor`,
          opacity: 0.15,
        }}
      />
    </div>
  );
}

export function DeviceOutlineSVG({
  device = "iphone",
  className,
  strokeColor = "currentColor",
  strokeOpacity = 0.15,
}: {
  device?: DeviceType;
  className?: string;
  strokeColor?: string;
  strokeOpacity?: number;
}) {
  const config = deviceConfigs[device];
  const padding = config.strokeWidth;

  return (
    <svg
      width={config.width + padding * 2}
      height={config.height + padding * 2}
      viewBox={`0 0 ${config.width + padding * 2} ${config.height + padding * 2}`}
      fill="none"
      className={className}
    >
      <rect
        x={padding}
        y={padding}
        width={config.width}
        height={config.height}
        rx={config.borderRadius}
        stroke={strokeColor}
        strokeWidth={config.strokeWidth}
        strokeOpacity={strokeOpacity}
        fill="none"
      />
    </svg>
  );
}
