import Link from "next/link";
import { Smartphone, Monitor, Palette, Camera } from "lucide-react";

export default function Home() {
  const screenshots = [
    { name: "Hero", path: "/screenshots/hero", description: "Main feature showcase" },
    { name: "Feature 1", path: "/screenshots/feature-1", description: "AI-powered workspace" },
    { name: "Feature 2", path: "/screenshots/feature-2", description: "Document collaboration" },
    { name: "Dark Mode", path: "/screenshots/dark-mode", description: "Dark theme showcase" },
    { name: "Collaboration", path: "/screenshots/collaboration", description: "Real-time features" },
  ];

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border">
        <div className="container mx-auto px-6 py-4">
          <h1 className="text-2xl font-bold text-foreground">PageSpace Marketing</h1>
          <p className="text-muted-foreground">Design sandbox and screenshot generator</p>
        </div>
      </header>

      <main className="container mx-auto px-6 py-8">
        <section className="mb-12">
          <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
            <Camera className="w-5 h-5" />
            App Store Screenshots
          </h2>
          <p className="text-muted-foreground mb-6">
            Pre-built marketing compositions at exact App Store dimensions.
            iPhone 6.9&quot; (1320x2868px) and iPad 13&quot; (2064x2752px).
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {screenshots.map((screenshot) => (
              <Link
                key={screenshot.path}
                href={screenshot.path}
                className="group p-6 rounded-xl border border-border bg-card hover:border-primary/50 hover:shadow-lg transition-all"
              >
                <div className="flex items-center gap-3 mb-2">
                  <Smartphone className="w-5 h-5 text-primary" />
                  <h3 className="font-medium text-foreground group-hover:text-primary transition-colors">
                    {screenshot.name}
                  </h3>
                </div>
                <p className="text-sm text-muted-foreground">{screenshot.description}</p>
              </Link>
            ))}
          </div>
        </section>

        <section className="mb-12">
          <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
            <Palette className="w-5 h-5" />
            Design Tools
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Link
              href="/playground"
              className="group p-6 rounded-xl border border-border bg-card hover:border-primary/50 hover:shadow-lg transition-all"
            >
              <div className="flex items-center gap-3 mb-2">
                <Monitor className="w-5 h-5 text-primary" />
                <h3 className="font-medium text-foreground group-hover:text-primary transition-colors">
                  Playground
                </h3>
              </div>
              <p className="text-sm text-muted-foreground">
                Live component browser, theme picker, and typography preview
              </p>
            </Link>
          </div>
        </section>

        <section>
          <h2 className="text-xl font-semibold mb-4">Quick Start</h2>
          <div className="p-4 rounded-lg bg-muted font-mono text-sm">
            <p className="text-muted-foreground mb-2"># Capture all screenshots</p>
            <p>pnpm --filter marketing capture</p>
          </div>
        </section>
      </main>
    </div>
  );
}
