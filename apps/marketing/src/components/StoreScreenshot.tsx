import Image from "next/image";
import { ScreenshotCanvas, Headline, Subline, Tag } from "@/components/ScreenshotCanvas";
import { DeviceOutline } from "@/components/DeviceFrame";
import { CANVAS, capturePath, type Shot, type ShotDevice } from "@/lib/app-store-shots";

/**
 * How far down the canvas the device sits, and how much it shrinks. The phone
 * gets more headroom because its canvas is the taller of the two; the tablet is
 * nearly square, so the copy block has to be tighter.
 */
const LAYOUT: Record<ShotDevice, { top: number; scale: number; copyTop: number; copyPad: number }> = {
  iphone: { top: 760, scale: 0.52, copyTop: 150, copyPad: 90 },
  ipad: { top: 880, scale: 0.58, copyTop: 130, copyPad: 160 },
};

export function StoreScreenshot({ shot, device }: { shot: Shot; device: ShotDevice }) {
  const layout = LAYOUT[device];
  const canvas = CANVAS[device];

  return (
    <ScreenshotCanvas size={device} id={`${device}-${shot.slug}`}>
      <div
        className="absolute left-0 right-0 text-center"
        style={{ top: layout.copyTop, paddingLeft: layout.copyPad, paddingRight: layout.copyPad }}
      >
        {shot.tag && <Tag className="mb-12">{shot.tag}</Tag>}
        <Headline>
          {shot.headline.map((line) => (
            <span key={line} style={{ display: "block" }}>
              {line}
            </span>
          ))}
        </Headline>
        <Subline className="mt-12 mx-auto" style={{ maxWidth: canvas.width * 0.74 }}>
          {shot.subline}
        </Subline>
      </div>

      <div
        className="absolute left-1/2"
        style={{ top: layout.top, transform: `translateX(-50%) scale(${layout.scale})`, transformOrigin: "top center" }}
      >
        <DeviceOutline device={device}>
          {/* Pixel-exact simulator capture: `unoptimized` keeps the optimizer
              from re-encoding it, so what ships is what the device drew. */}
          <Image
            src={capturePath(device, shot.slug)}
            alt=""
            width={canvas.width}
            height={canvas.height}
            unoptimized
            priority
          />
        </DeviceOutline>
      </div>
    </ScreenshotCanvas>
  );
}
