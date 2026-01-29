import { ScreenshotCanvas, Headline, Subline, Tag } from "@/components/ScreenshotCanvas";
import { DeviceOutline } from "@/components/DeviceFrame";
import { MockAppPreview } from "@/components/MockAppPreview";

export default function Feature2Screenshot() {
  return (
    <ScreenshotCanvas
      size="iphone"
      background="bg-gradient-to-b from-background via-background to-chart-2/5"
      id="feature-2"
    >
      {/* Copy */}
      <div className="absolute top-24 left-0 right-0 px-20 text-center z-10">
        <Tag className="mb-10">Documents</Tag>
        <Headline>
          Write.<br />
          Think.<br />
          Ship.
        </Headline>
        <Subline className="mt-10 max-w-3xl mx-auto">
          Rich text. Code blocks. Embeds. No learning curve.
        </Subline>
      </div>

      {/* Device */}
      <div
        className="absolute left-1/2 -translate-x-1/2"
        style={{ top: 750, transform: "translateX(-50%) scale(0.52)" }}
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
