import Link from "next/link";
import { Sparkles, Download, Apple, Monitor, Smartphone, ExternalLink, CheckCircle2, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SiteFooter } from "@/components/SiteFooter";
import { pageMetadata, APP_URL } from "@/lib/metadata";

export const metadata = pageMetadata.downloads;

// ─── Release Config ─────────────────────────────────────────
// Update RELEASE_TAG to point all download links to a new release.
const RELEASE_TAG = "desktop-v1.0.18";
const VERSION = "1.0.18";
const RELEASE_DATE = "February 9, 2026";
const DOWNLOAD_BASE = `https://github.com/2witstudios/PageSpace/releases/download/${RELEASE_TAG}`;

const TESTFLIGHT_URL = "https://testflight.apple.com/join/HdNDfpCC";

interface DownloadOption {
  platform: string;
  arch?: string;
  label: string;
  filename: string;
  size: string;
  icon: React.ReactNode;
  url: string;
}

const desktopDownloads: DownloadOption[] = [
  {
    platform: "macOS",
    label: "Mac",
    filename: "PageSpace.dmg",
    size: "177 MB",
    icon: <Apple className="h-5 w-5" />,
    url: `${DOWNLOAD_BASE}/PageSpace.dmg`,
  },
  {
    platform: "Windows",
    label: "Windows",
    filename: "PageSpace.exe",
    size: "80 MB",
    icon: <Monitor className="h-5 w-5" />,
    url: `${DOWNLOAD_BASE}/PageSpace.exe`,
  },
  {
    platform: "Linux",
    arch: "AppImage",
    label: "Linux (AppImage)",
    filename: "PageSpace.AppImage",
    size: "106 MB",
    icon: <Monitor className="h-5 w-5" />,
    url: `${DOWNLOAD_BASE}/PageSpace.AppImage`,
  },
  {
    platform: "Linux",
    arch: "deb",
    label: "Linux (Debian/Ubuntu)",
    filename: "PageSpace.deb",
    size: "73 MB",
    icon: <Monitor className="h-5 w-5" />,
    url: `${DOWNLOAD_BASE}/PageSpace.deb`,
  },
  {
    platform: "Linux",
    arch: "rpm",
    label: "Linux (Fedora/RHEL)",
    filename: "PageSpace.rpm",
    size: "73 MB",
    icon: <Monitor className="h-5 w-5" />,
    url: `${DOWNLOAD_BASE}/PageSpace.rpm`,
  },
];

const systemRequirements = {
  macOS: {
    os: "macOS 12 (Monterey) or later",
    processor: "Apple Silicon or Intel",
    memory: "4 GB RAM minimum, 8 GB recommended",
    storage: "500 MB available space",
  },
  Windows: {
    os: "Windows 10 (64-bit) or later",
    processor: "Intel Core i5 or equivalent",
    memory: "4 GB RAM minimum, 8 GB recommended",
    storage: "500 MB available space",
  },
  Linux: {
    os: "Ubuntu 20.04, Debian 10, Fedora 34, or equivalent",
    processor: "x86_64 processor",
    memory: "4 GB RAM minimum, 8 GB recommended",
    storage: "500 MB available space",
  },
};

export default function DownloadsPage() {
  return (
    <div className="min-h-screen bg-background">
      {/* Navigation */}
      <header className="sticky top-0 z-50 w-full border-b border-border/40 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container mx-auto flex h-16 items-center justify-between px-4 md:px-6">
          <Link href="/" className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary">
              <Sparkles className="h-5 w-5 text-primary-foreground" />
            </div>
            <span className="text-xl font-bold">PageSpace</span>
          </Link>
          <nav className="hidden md:flex items-center gap-6">
            <Link href="/pricing" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
              Pricing
            </Link>
            <Link href="/downloads" className="text-sm font-medium text-foreground transition-colors">
              Downloads
            </Link>
            <Link href="/docs" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
              Docs
            </Link>
            <Link href="/blog" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
              Blog
            </Link>
          </nav>
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" asChild className="hidden sm:inline-flex">
              <a href={`${APP_URL}/auth/signin`}>Log in</a>
            </Button>
            <Button size="sm" asChild>
              <a href={`${APP_URL}/auth/signup`}>Get Started</a>
            </Button>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="py-16 md:py-24">
        <div className="container mx-auto px-4 md:px-6">
          <div className="mx-auto max-w-3xl text-center">
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-muted/50 px-4 py-1.5 text-sm">
              <Download className="h-4 w-4 text-primary" />
              <span className="text-muted-foreground">Download PageSpace</span>
            </div>
            <h1 className="text-4xl font-bold tracking-tight sm:text-5xl md:text-6xl mb-6">
              Get PageSpace for your platform
            </h1>
            <p className="text-lg text-muted-foreground mb-4">
              Available for Mac, Windows, and Linux. Native performance with automatic updates.
            </p>
            <p className="text-sm text-muted-foreground">
              Current version: <span className="font-medium text-foreground">{VERSION}</span>
              <span className="mx-2">•</span>
              Released {RELEASE_DATE}
            </p>
          </div>
        </div>
      </section>

      {/* Desktop Downloads */}
      <section className="pb-16 md:pb-24">
        <div className="container mx-auto px-4 md:px-6">
          <div className="mx-auto max-w-4xl">
            <h2 className="text-2xl font-bold mb-8 flex items-center gap-3">
              <Monitor className="h-6 w-6 text-primary" />
              Desktop Apps
            </h2>

            {/* Download Cards */}
            <div className="grid md:grid-cols-2 gap-4 mb-12">
              {desktopDownloads.map((download) => (
                <div
                  key={`${download.platform}-${download.arch}`}
                  className="rounded-xl border border-border bg-card p-6 hover:border-primary/50 transition-colors"
                >
                  <div className="flex items-start justify-between mb-4">
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                        {download.icon}
                      </div>
                      <div>
                        <h3 className="font-semibold">{download.label}</h3>
                        <p className="text-sm text-muted-foreground">{download.size}</p>
                      </div>
                    </div>
                  </div>
                  <Button className="w-full" variant="outline" asChild>
                    <a href={download.url} download>
                      <Download className="mr-2 h-4 w-4" />
                      Download {download.filename}
                    </a>
                  </Button>
                </div>
              ))}
            </div>

            {/* Auto-update info */}
            <div className="rounded-xl border border-border bg-muted/30 p-6 mb-12">
              <div className="flex items-start gap-4">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-500/10 flex-shrink-0">
                  <CheckCircle2 className="h-5 w-5 text-green-500" />
                </div>
                <div>
                  <h3 className="font-semibold mb-1">Automatic Updates</h3>
                  <p className="text-sm text-muted-foreground">
                    PageSpace automatically updates in the background. You&apos;ll always have the latest features
                    and security fixes without any manual intervention.
                  </p>
                </div>
              </div>
            </div>

            {/* System Requirements */}
            <h3 className="text-xl font-semibold mb-6">System Requirements</h3>
            <div className="grid md:grid-cols-3 gap-6 mb-16">
              {Object.entries(systemRequirements).map(([platform, reqs]) => (
                <div key={platform} className="rounded-xl border border-border bg-card p-6">
                  <h4 className="font-semibold mb-4 flex items-center gap-2">
                    {platform === "macOS" && <Apple className="h-4 w-4" />}
                    {platform === "Windows" && <Monitor className="h-4 w-4" />}
                    {platform === "Linux" && <Monitor className="h-4 w-4" />}
                    {platform}
                  </h4>
                  <ul className="space-y-2 text-sm text-muted-foreground">
                    <li><span className="text-foreground">OS:</span> {reqs.os}</li>
                    <li><span className="text-foreground">Processor:</span> {reqs.processor}</li>
                    <li><span className="text-foreground">Memory:</span> {reqs.memory}</li>
                    <li><span className="text-foreground">Storage:</span> {reqs.storage}</li>
                  </ul>
                </div>
              ))}
            </div>

            {/* Mobile Apps */}
            <h2 className="text-2xl font-bold mb-8 flex items-center gap-3">
              <Smartphone className="h-6 w-6 text-primary" />
              Mobile Apps
              <span className="text-sm font-normal bg-primary/10 text-primary px-2 py-0.5 rounded">Beta</span>
            </h2>

            <div className="grid md:grid-cols-2 gap-4 mb-8">
              {/* iOS */}
              <div className="rounded-xl border border-border bg-card p-6">
                <div className="flex items-start justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                      <Apple className="h-5 w-5" />
                    </div>
                    <div>
                      <h3 className="font-semibold">iOS</h3>
                      <p className="text-sm text-muted-foreground">iPhone & iPad</p>
                    </div>
                  </div>
                  <span className="text-xs bg-amber-500/10 text-amber-600 px-2 py-1 rounded">TestFlight</span>
                </div>
                <Button variant="outline" className="w-full" asChild>
                  <a href={TESTFLIGHT_URL} target="_blank" rel="noopener noreferrer">
                    Join TestFlight
                    <ExternalLink className="ml-2 h-4 w-4" />
                  </a>
                </Button>
              </div>

              {/* Android */}
              <div className="rounded-xl border border-border bg-card p-6">
                <div className="flex items-start justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                      <Smartphone className="h-5 w-5" />
                    </div>
                    <div>
                      <h3 className="font-semibold">Android</h3>
                      <p className="text-sm text-muted-foreground">Phone & Tablet</p>
                    </div>
                  </div>
                  <span className="text-xs bg-amber-500/10 text-amber-600 px-2 py-1 rounded">Beta</span>
                </div>
                <Button variant="outline" className="w-full" disabled>
                  Coming Soon
                </Button>
              </div>
            </div>

            {/* Beta Notice */}
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-6">
              <div className="flex items-start gap-4">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-500/10 flex-shrink-0">
                  <Info className="h-5 w-5 text-amber-600" />
                </div>
                <div>
                  <h3 className="font-semibold mb-1">Mobile Apps in Beta</h3>
                  <p className="text-sm text-muted-foreground">
                    Our mobile apps are currently in beta testing. While core features work well, you may encounter
                    occasional bugs. We&apos;d love your feedback to help us improve!
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
