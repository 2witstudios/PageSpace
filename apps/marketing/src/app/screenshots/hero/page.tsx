import { ScreenshotCanvas, Headline, Subline, Tag } from "@/components/ScreenshotCanvas";
import { DeviceOutline } from "@/components/DeviceFrame";
import { MockAppPreview } from "@/components/MockAppPreview";

export default function HeroScreenshot() {
  return (
    <ScreenshotCanvas
      size="iphone"
      background="bg-gradient-to-b from-background via-background to-primary/5"
      id="hero"
    >
      {/* Copy */}
      <div className="absolute top-24 left-0 right-0 px-20 text-center z-10">
        <Tag className="mb-10">Workspace</Tag>
        <Headline>
          Everything.<br />
          One place.
        </Headline>
        <Subline className="mt-10 max-w-3xl mx-auto">
          Docs. Conversations. AI that actually knows your stuff.
        </Subline>
      </div>

      {/* Device */}
      <div
        className="absolute left-1/2 -translate-x-1/2"
        style={{ top: 700, transform: "translateX(-50%) scale(0.52)" }}
      >
        <DeviceOutline device="iphone">
          <MockAppPreview variant="document" />
        </DeviceOutline>
      </div>

      {/* Fade */}
      <div className="absolute bottom-0 left-0 right-0 h-80 bg-gradient-to-t from-background to-transparent pointer-events-none" />
    </ScreenshotCanvas>
  );
}
