import Link from "next/link";
import { Smartphone, Tablet, ArrowLeft } from "lucide-react";

const screenshots = [
  {
    name: "Hero",
    path: "/screenshots/hero",
    description: "Main feature showcase with device mockup",
    device: "iPhone 6.9\"",
  },
  {
    name: "Feature 1: AI Workspace",
    path: "/screenshots/feature-1",
    description: "AI-powered document assistant",
    device: "iPhone 6.9\"",
  },
  {
    name: "Feature 2: Documents",
    path: "/screenshots/feature-2",
    description: "Rich document editing",
    device: "iPhone 6.9\"",
  },
  {
    name: "Dark Mode",
    path: "/screenshots/dark-mode",
    description: "Dark theme showcase",
    device: "iPhone 6.9\"",
  },
  {
    name: "Collaboration",
    path: "/screenshots/collaboration",
    description: "Real-time team collaboration",
    device: "iPhone 6.9\"",
  },
];

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
              <span>iPhone 6.9&quot;: 1320 x 2868px</span>
            </div>
            <div className="flex items-center gap-2">
              <Tablet className="w-4 h-4" />
              <span>iPad 13&quot;: 2064 x 2752px</span>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {screenshots.map((screenshot) => (
            <Link
              key={screenshot.path}
              href={screenshot.path}
              className="group block"
            >
              <div className="aspect-[1320/2868] rounded-xl border border-border bg-card overflow-hidden mb-3 hover:border-primary/50 hover:shadow-lg transition-all">
                <div className="w-full h-full flex items-center justify-center text-muted-foreground">
                  <Smartphone className="w-12 h-12" />
                </div>
              </div>
              <h3 className="font-medium text-foreground group-hover:text-primary transition-colors">
                {screenshot.name}
              </h3>
              <p className="text-sm text-muted-foreground">{screenshot.description}</p>
              <p className="text-xs text-muted-foreground mt-1">{screenshot.device}</p>
            </Link>
          ))}
        </div>

        <div className="mt-12 p-6 rounded-xl border border-border bg-card">
          <h2 className="font-semibold mb-4">Capture All Screenshots</h2>
          <div className="font-mono text-sm bg-muted p-4 rounded-lg">
            <p className="text-muted-foreground mb-2"># Run Playwright capture script</p>
            <p>pnpm --filter marketing capture</p>
          </div>
          <p className="text-sm text-muted-foreground mt-4">
            Output will be saved to <code className="bg-muted px-1.5 py-0.5 rounded">apps/marketing/output/</code>
          </p>
        </div>
      </main>
    </div>
  );
}
