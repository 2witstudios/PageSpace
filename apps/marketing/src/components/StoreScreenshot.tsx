import Image from "next/image";
import { ScreenshotCanvas, Headline, Subline, Tag } from "@/components/ScreenshotCanvas";
import { DeviceOutline } from "@/components/DeviceFrame";
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
/* Tuned against rendered composites, not guessed: the first pass left a fifth of
   each canvas empty below the device, and on iPad the device sat 36px off the
   right edge, which reads as a mistake rather than a bleed. */
const PORTRAIT = { copyTop: 150, copyPad: 90, deviceTop: 780, scale: 0.6 };
const LANDSCAPE = { copyLeft: 110, copyWidth: 720, deviceLeft: 880, deviceTop: 360, scale: 0.65 };

export function StoreScreenshot({ shot, device }: { shot: Shot; device: ShotDevice }) {
  const canvas = CANVAS[device];

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
          className="absolute"
          style={{ left: LANDSCAPE.copyLeft, top: 0, bottom: 0, width: LANDSCAPE.copyWidth, display: "flex", flexDirection: "column", justifyContent: "center" }}
        >
          {shot.tag && <Tag className="mb-10 self-start">{shot.tag}</Tag>}
          <Headline>
            {shot.headline.map((line) => (
              <span key={line} style={{ display: "block" }}>
                {line}
              </span>
            ))}
          </Headline>
          <Subline className="mt-10">{shot.subline}</Subline>
        </div>

        <div
          className="absolute"
          style={{
            left: LANDSCAPE.deviceLeft,
            top: LANDSCAPE.deviceTop,
            transform: `scale(${LANDSCAPE.scale})`,
            transformOrigin: "top left",
          }}
        >
          <DeviceOutline device={device}>{capture}</DeviceOutline>
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
        <Subline className="mt-12 mx-auto" style={{ maxWidth: canvas.width * 0.74 }}>
          {shot.subline}
        </Subline>
      </div>

      <div
        className="absolute left-1/2"
        style={{
          top: PORTRAIT.deviceTop,
          transform: `translateX(-50%) scale(${PORTRAIT.scale})`,
          transformOrigin: "top center",
        }}
      >
        <DeviceOutline device={device}>{capture}</DeviceOutline>
      </div>
    </ScreenshotCanvas>
  );
}
