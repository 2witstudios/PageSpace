import Image from "next/image";
import { ScreenshotCanvas, Headline, Subline, Tag } from "@/components/ScreenshotCanvas";
import { DeviceWithReflection } from "@/components/DeviceFrame";
import { CANVAS, capturePath, type Shot, type ShotDevice } from "@/lib/app-store-shots";

/**
 * Two layouts, because the canvases are shaped differently and one compromise
 * would serve neither.
 *
 * Portrait (iPhone) stacks copy over device, which is how phone store
 * screenshots universally read. Landscape (iPad) sets copy beside the device,
 * mirroring the landing hero — and it keeps the device large, which matters
 * because the whole point of shipping iPad shots is showing the three-pane
 * layout a phone cannot.
 */
/* Tuned against rendered composites, not guessed.
   Landscape went through two passes. Copy beside the device mirrored the landing
   hero, but a 720px column wraps a 132px headline onto four lines and caps the
   device at 0.65 — and an iPad capture is dense UI that a store listing already
   renders a few hundred pixels wide. Copy now runs full width across the top,
   which lets the device grow and stops the headlines breaking mid-phrase. */
/* Scale now applies to the whole bezel, not the bare screen — the iPhone frame
   is 1470x3000 around a 1320x2868 screen, the iPad 3000x2300 around 2752x2064.
   Both devices sit slightly higher than before to leave the reflection somewhere
   to fade; it is allowed to run off the bottom, where the canvas clips it. */
const PORTRAIT = { copyTop: 150, copyPad: 90, deviceTop: 640, scale: 0.685 };
const LANDSCAPE = { copyLeft: 150, copyTop: 120, copyWidth: 2400, deviceTop: 360, scale: 0.70 };

export function StoreScreenshot({ shot, device }: { shot: Shot; device: ShotDevice }) {
  const canvas = CANVAS[device];
  // Only `builds` carries a caption, and it needs a line's worth of room the
  // caption-free layout does not reserve — without this the device rides up
  // over it.
  const hasCaption = Boolean(shot.subline);

  const capture = (
    /* Pixel-exact simulator capture: `unoptimized` keeps the optimizer from
       re-encoding it, so what ships is what the device drew. */
    <Image
      src={capturePath(device, shot.slug)}
      alt=""
      width={canvas.width}
      height={canvas.height}
      unoptimized
      priority
    />
  );

  if (canvas.orientation === "landscape") {
    return (
      <ScreenshotCanvas size={device} id={`${device}-${shot.slug}`}>
        <div
          className="absolute flex flex-col items-start"
          style={{ left: LANDSCAPE.copyLeft, top: LANDSCAPE.copyTop, width: LANDSCAPE.copyWidth }}
        >
          {shot.tag && <Tag className="mb-8">{shot.tag}</Tag>}
          {/* One line at this width — the canvas is wide enough that the
              portrait line break would read as an accident. */}
          <Headline>{shot.headline.join(" ")}</Headline>
          {shot.subline && <Subline className="mt-8">{shot.subline}</Subline>}
        </div>

        <div
          className="absolute left-1/2"
          style={{
            top: LANDSCAPE.deviceTop + (hasCaption ? 90 : 0),
            transform: `translateX(-50%) scale(${hasCaption ? 0.665 : LANDSCAPE.scale})`,
            transformOrigin: "top center",
          }}
        >
          <DeviceWithReflection device={device}>{capture}</DeviceWithReflection>
        </div>
      </ScreenshotCanvas>
    );
  }

  return (
    <ScreenshotCanvas size={device} id={`${device}-${shot.slug}`}>
      <div
        className="absolute left-0 right-0 text-center"
        style={{ top: PORTRAIT.copyTop, paddingLeft: PORTRAIT.copyPad, paddingRight: PORTRAIT.copyPad }}
      >
        {shot.tag && <Tag className="mb-12">{shot.tag}</Tag>}
        <Headline>
          {shot.headline.map((line) => (
            <span key={line} style={{ display: "block" }}>
              {line}
            </span>
          ))}
        </Headline>
        {shot.subline && (
          <Subline className="mt-12 mx-auto" style={{ maxWidth: canvas.width * 0.74 }}>
            {shot.subline}
          </Subline>
        )}
      </div>

      <div
        className="absolute left-1/2"
        style={{
          top: PORTRAIT.deviceTop + (hasCaption ? 110 : 0),
          transform: `translateX(-50%) scale(${hasCaption ? 0.65 : PORTRAIT.scale})`,
          transformOrigin: "top center",
        }}
      >
        <DeviceWithReflection device={device}>{capture}</DeviceWithReflection>
      </div>
    </ScreenshotCanvas>
  );
}
