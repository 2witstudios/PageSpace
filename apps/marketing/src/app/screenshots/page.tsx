import Link from "next/link";
import { Smartphone, Tablet, ArrowLeft } from "lucide-react";
import { CANVAS, DEVICES, SHOTS, capturePath } from "@/lib/app-store-shots";

export default function ScreenshotsPage() {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border">
        <div className="container mx-auto px-6 py-4">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors mb-4"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Home
          </Link>
          <h1 className="text-2xl font-bold text-foreground">App Store Screenshots</h1>
          <p className="text-muted-foreground">
            Click any template to view at full resolution
          </p>
        </div>
      </header>

      <main className="container mx-auto px-6 py-8">
        <div className="mb-8 p-4 rounded-lg bg-muted">
          <h2 className="font-semibold mb-2">Dimensions</h2>
          <div className="flex gap-6 text-sm">
            <div className="flex items-center gap-2">
              <Smartphone className="w-4 h-4" />
              <span>
                {CANVAS.iphone.label}: {CANVAS.iphone.width} x {CANVAS.iphone.height}px
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Tablet className="w-4 h-4" />
              <span>
                {CANVAS.ipad.label}: {CANVAS.ipad.width} x {CANVAS.ipad.height}px
              </span>
            </div>
          </div>
        </div>

        {DEVICES.map((device) => (
          <section key={device} className="mb-10">
            <h2 className="font-semibold text-foreground mb-4">{CANVAS[device].label}</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {SHOTS.map((shot) => (
                <Link key={shot.slug} href={`/screenshots/${device}/${shot.slug}`} className="group block">
                  <div
                    className="rounded-xl border border-border bg-card overflow-hidden mb-3 flex items-center justify-center text-muted-foreground hover:border-primary/50 hover:shadow-lg transition-all"
                    style={{ aspectRatio: `${CANVAS[device].width} / ${CANVAS[device].height}` }}
                  >
                    {device === "ipad" ? <Tablet className="w-12 h-12" /> : <Smartphone className="w-12 h-12" />}
                  </div>
                  <h3 className="font-medium text-foreground group-hover:text-primary transition-colors">
                    {shot.headline.join(" ")}
                  </h3>
                  <p className="text-sm text-muted-foreground">{shot.subline}</p>
                  <p className="text-xs text-muted-foreground mt-1 font-mono">
                    {capturePath(device, shot.slug)}
                  </p>
                </Link>
              ))}
            </div>
          </section>
        ))}

        <div className="mt-12 p-6 rounded-xl border border-border bg-card">
          <h2 className="font-semibold mb-4">Capture All Screenshots</h2>
          <ol className="text-sm text-muted-foreground list-decimal pl-5 space-y-1 mb-4">
            <li>
              Record each screen off a simulator running the shipping build:{" "}
              <code className="bg-muted px-1.5 py-0.5 rounded">xcrun simctl io booted screenshot &lt;slug&gt;.png</code>
            </li>
            <li>
              Save them under{" "}
              <code className="bg-muted px-1.5 py-0.5 rounded">public/screenshots/ios/&lt;device&gt;/</code>
            </li>
            <li>Run the capture script — it fails if any capture is missing.</li>
          </ol>
          <div className="font-mono text-sm bg-muted p-4 rounded-lg">
            <p>bun run --cwd apps/marketing capture</p>
          </div>
          <p className="text-sm text-muted-foreground mt-4">
            Output is written to <code className="bg-muted px-1.5 py-0.5 rounded">apps/marketing/output/</code>
          </p>
        </div>
      </main>
    </div>
  );
}
