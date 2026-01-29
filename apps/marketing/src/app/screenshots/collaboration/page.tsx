import { ScreenshotCanvas, Headline, Subline, Tag } from "@/components/ScreenshotCanvas";
import { DeviceOutline } from "@/components/DeviceFrame";
import { MockAppPreview } from "@/components/MockAppPreview";

export default function CollaborationScreenshot() {
  return (
    <ScreenshotCanvas
      size="iphone"
      background="bg-gradient-to-b from-background via-background to-chart-1/5"
      id="collaboration"
    >
      {/* Copy */}
      <div className="absolute top-24 left-0 right-0 px-20 text-center z-10">
        <Tag className="mb-10">Real-time</Tag>
        <Headline>
          Same page.<br />
          Same time.
        </Headline>
        <Subline className="mt-10 max-w-3xl mx-auto">
          See cursors. See changes. No refresh required.
        </Subline>
      </div>

      {/* Presence indicators */}
      <div className="absolute top-[580px] left-1/2 -translate-x-1/2 flex -space-x-3 z-10">
        <div className="w-14 h-14 rounded-full bg-blue-500 border-4 border-background flex items-center justify-center text-white font-semibold">
          J
        </div>
        <div className="w-14 h-14 rounded-full bg-emerald-500 border-4 border-background flex items-center justify-center text-white font-semibold">
          S
        </div>
        <div className="w-14 h-14 rounded-full bg-violet-500 border-4 border-background flex items-center justify-center text-white font-semibold">
          M
        </div>
      </div>

      {/* Device */}
      <div
        className="absolute left-1/2 -translate-x-1/2"
        style={{ top: 720, transform: "translateX(-50%) scale(0.52)" }}
      >
        <DeviceOutline device="iphone">
          <MockAppPreview variant="canvas" />
        </DeviceOutline>
      </div>

      {/* Fade */}
      <div className="absolute bottom-0 left-0 right-0 h-80 bg-gradient-to-t from-background to-transparent pointer-events-none" />
    </ScreenshotCanvas>
  );
}
