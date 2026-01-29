import { ScreenshotCanvas, Headline, Subline } from "@/components/ScreenshotCanvas";
import { DeviceOutline } from "@/components/DeviceFrame";
import { MockAppPreview } from "@/components/MockAppPreview";

export default function DarkModeScreenshot() {
  return (
    <ScreenshotCanvas
      size="iphone"
      background="bg-[#0a0a0a]"
      id="dark-mode"
    >
      <div className="w-full h-full dark">
        {/* Copy */}
        <div className="absolute top-24 left-0 right-0 px-20 text-center z-10">
          <Headline className="text-white">
            Light off.
          </Headline>
          <Subline className="mt-10 max-w-3xl mx-auto text-white/50">
            Designed dark. Not inverted.
          </Subline>
        </div>

        {/* Device */}
        <div
          className="absolute left-1/2 -translate-x-1/2"
          style={{ top: 550, transform: "translateX(-50%) scale(0.52)" }}
        >
          <DeviceOutline device="iphone">
            <div className="dark bg-background w-full h-full">
              <MockAppPreview variant="chat" />
            </div>
          </DeviceOutline>
        </div>

        {/* Fade */}
        <div className="absolute bottom-0 left-0 right-0 h-80 bg-gradient-to-t from-[#0a0a0a] to-transparent pointer-events-none" />
      </div>
    </ScreenshotCanvas>
  );
}
