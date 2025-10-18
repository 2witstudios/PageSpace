'use client';

import Link from "next/link";
import { Apple, Download, Github } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useEffect, useState } from "react";
import { isElectron } from "@/lib/utils";

export default function DownloadsPage() {
  const [inElectron, setInElectron] = useState(false);

  useEffect(() => {
    setInElectron(isElectron());
  }, []);

  // If running in Electron, redirect to dashboard
  useEffect(() => {
    if (inElectron) {
      window.location.href = '/dashboard';
    }
  }, [inElectron]);

  // Don't render anything if in Electron (will redirect)
  if (inElectron) {
    return null;
  }

  return (
    <div className="flex flex-col min-h-screen">
      <header className="w-full border-b">
        <div className="container mx-auto flex h-14 items-center px-4 sm:px-6 lg:px-8">
          <Link className="flex items-center justify-center" href="/">
            <span className="text-xl font-semibold">PageSpace</span>
          </Link>
          <nav className="ml-auto flex gap-4 sm:gap-6">
            <Link
              className="text-sm font-medium hover:underline underline-offset-4"
              href="/dashboard"
            >
              Dashboard
            </Link>
          </nav>
        </div>
      </header>

      <main className="flex-1">
        <section className="w-full py-20 md:py-32 lg:py-40 bg-background">
          <div className="container mx-auto px-4 md:px-6">
            <div className="flex flex-col items-center space-y-6 text-center">
              <div className="space-y-4">
                <h1 className="text-4xl font-bold tracking-tighter sm:text-5xl md:text-6xl">
                  Download PageSpace
                </h1>
                <p className="mx-auto max-w-[700px] text-lg text-muted-foreground md:text-xl">
                  Get the native desktop app for macOS, Windows, and Linux. Dedicated application with native integrations.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="w-full py-16 md:py-24 bg-muted">
          <div className="container mx-auto px-4 md:px-6">
            <div className="grid gap-8 lg:grid-cols-3 max-w-6xl mx-auto">
              {/* macOS */}
              <Card className="border-2 hover:border-primary/50 transition-colors">
                <CardHeader>
                  <div className="flex items-center gap-3 mb-2">
                    <Apple className="w-8 h-8" />
                    <CardTitle>macOS</CardTitle>
                  </div>
                  <CardDescription>
                    Universal binary for Intel and Apple Silicon
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <div className="flex gap-2">
                      <Badge variant="secondary">Signed & Notarized</Badge>
                      <Badge variant="secondary">Auto-Updates</Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      Fully signed and notarized by Apple. Includes automatic updates. No security warnings.
                    </p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-sm font-medium">System Requirements:</p>
                    <ul className="text-sm text-muted-foreground space-y-1">
                      <li>• macOS 11 (Big Sur) or later</li>
                      <li>• Intel or Apple Silicon Mac</li>
                    </ul>
                  </div>
                  <div className="space-y-1">
                    <p className="text-sm font-medium">Available Downloads:</p>
                    <ul className="text-sm text-muted-foreground space-y-1">
                      <li>• PageSpace.dmg (Installer)</li>
                      <li>• PageSpace.zip (Portable)</li>
                    </ul>
                  </div>
                </CardContent>
                <CardFooter className="flex flex-col gap-2">
                  <Button asChild className="w-full" size="lg">
                    <Link
                      href="https://github.com/2witstudios/PageSpace/releases/latest"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <Download className="w-4 h-4 mr-2" />
                      Download for macOS
                    </Link>
                  </Button>
                </CardFooter>
              </Card>

              {/* Windows */}
              <Card className="border-2 hover:border-primary/50 transition-colors">
                <CardHeader>
                  <div className="flex items-center gap-3 mb-2">
                    <svg className="w-8 h-8" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M0 3.449L9.75 2.1v9.451H0m10.949-9.602L24 0v11.4H10.949M0 12.6h9.75v9.451L0 20.699M10.949 12.6H24V24l-12.9-1.801"/>
                    </svg>
                    <CardTitle>Windows</CardTitle>
                  </div>
                  <CardDescription>
                    NSIS installer for Windows 10/11
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Badge variant="outline">Unsigned</Badge>
                    <p className="text-sm text-muted-foreground">
                      Currently unsigned. Windows SmartScreen will show a warning - click &quot;More info&quot; then &quot;Run anyway&quot;.
                    </p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-sm font-medium">System Requirements:</p>
                    <ul className="text-sm text-muted-foreground space-y-1">
                      <li>• Windows 10 or later</li>
                      <li>• 64-bit (x64) architecture</li>
                    </ul>
                  </div>
                  <div className="space-y-1">
                    <p className="text-sm font-medium">Available Downloads:</p>
                    <ul className="text-sm text-muted-foreground space-y-1">
                      <li>• PageSpace.exe (Installer)</li>
                    </ul>
                  </div>
                </CardContent>
                <CardFooter className="flex flex-col gap-2">
                  <Button asChild variant="outline" className="w-full" size="lg">
                    <Link
                      href="https://github.com/2witstudios/PageSpace/releases/latest"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <Download className="w-4 h-4 mr-2" />
                      Download for Windows
                    </Link>
                  </Button>
                </CardFooter>
              </Card>

              {/* Linux */}
              <Card className="border-2 hover:border-primary/50 transition-colors">
                <CardHeader>
                  <div className="flex items-center gap-3 mb-2">
                    <svg className="w-8 h-8" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12.504 0c-.155 0-.315.008-.480.021-4.226.333-3.105 4.807-3.17 6.298-.076 1.092-.3 1.953-1.05 3.02-.885 1.051-2.127 2.75-2.716 4.521-.278.84-.41 1.684-.287 2.489a.424.424 0 00-.11.135c-.26.268-.45.6-.663.839-.199.199-.485.267-.797.4-.313.136-.658.269-.864.68-.09.189-.136.394-.132.602 0 .199.027.401.055.536.058.399.116.728.04.97-.249.68-.28 1.145-.106 1.484.174.334.535.47.94.601.81.2 1.91.135 2.774.6.926.466 1.866.67 2.616.47.526-.116.97-.464 1.208-.946.587-.003 1.23-.269 2.26-.334.699-.058 1.574.267 2.577.2.025.134.063.198.114.333l.003.003c.391.778 1.113 1.132 1.884 1.071.771-.06 1.592-.536 2.257-1.306.631-.765 1.683-1.084 2.378-1.503.348-.199.629-.469.649-.853.023-.4-.2-.811-.714-1.376v-.097l-.003-.003c-.17-.2-.25-.535-.338-.926-.085-.401-.182-.786-.492-1.046h-.003c-.059-.054-.123-.067-.188-.135a.357.357 0 00-.19-.064c.431-1.278.264-2.55-.173-3.694-.533-1.41-1.465-2.638-2.175-3.483-.796-1.005-1.576-1.957-1.56-3.368.026-2.152.236-6.133-3.544-6.139zm.529 3.405h.013c.213 0 .396.062.584.198.19.135.33.332.438.533.105.259.158.459.166.724 0-.02.006-.04.006-.06v.105a.086.086 0 01-.004-.021l-.004-.024a1.807 1.807 0 01-.15.706.953.953 0 01-.213.335.71.71 0 00-.088-.042c-.104-.045-.198-.064-.284-.133a1.312 1.312 0 00-.22-.066c.05-.06.146-.133.183-.198.053-.128.082-.264.088-.402v-.02a1.21 1.21 0 00-.061-.4c-.045-.134-.101-.2-.183-.333-.084-.066-.167-.132-.267-.132h-.016c-.093 0-.176.03-.262.132a.8.8 0 00-.205.334 1.18 1.18 0 00-.09.4v.019c.002.089.008.179.02.267-.193-.067-.438-.135-.607-.202a1.635 1.635 0 01.471-1.133 1.8 1.8 0 011.219-.469zm3.955 12.238c-.011.044-.03.086-.076.131-.046.045-.09.06-.136.074h-.016c-.045 0-.09-.015-.135-.06-.046-.03-.061-.074-.076-.12a.556.556 0 01.076-.258.56.56 0 01.228-.135c.06-.03.12-.044.182-.044h.015c.046 0 .09.015.135.06.045.044.06.089.075.134.015.045.03.09.015.135-.015.06-.03.105-.06.15 0-.015 0-.03-.015-.044a.428.428 0 00-.228-.09h-.015c-.045 0-.09.015-.135.044a.344.344 0 00-.135.135c-.03.06-.045.12-.03.179.015.06.03.105.075.15.045.044.09.074.135.089.046.015.09.015.136 0 .045-.015.09-.044.12-.09.015-.015.03-.044.045-.074.015-.03.015-.06.015-.089z"/>
                    </svg>
                    <CardTitle>Linux</CardTitle>
                  </div>
                  <CardDescription>
                    Universal packages for all major distributions
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Badge variant="secondary">Multiple Formats</Badge>
                    <p className="text-sm text-muted-foreground">
                      Choose the package format that works best for your distribution.
                    </p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-sm font-medium">System Requirements:</p>
                    <ul className="text-sm text-muted-foreground space-y-1">
                      <li>• Modern Linux distribution</li>
                      <li>• 64-bit (x64) architecture</li>
                    </ul>
                  </div>
                  <div className="space-y-1">
                    <p className="text-sm font-medium">Available Downloads:</p>
                    <ul className="text-sm text-muted-foreground space-y-1">
                      <li>• PageSpace.AppImage (Universal)</li>
                      <li>• PageSpace.deb (Debian/Ubuntu)</li>
                      <li>• PageSpace.rpm (RedHat/Fedora)</li>
                    </ul>
                  </div>
                </CardContent>
                <CardFooter className="flex flex-col gap-2">
                  <Button asChild variant="outline" className="w-full" size="lg">
                    <Link
                      href="https://github.com/2witstudios/PageSpace/releases/latest"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <Download className="w-4 h-4 mr-2" />
                      Download for Linux
                    </Link>
                  </Button>
                </CardFooter>
              </Card>
            </div>

            {/* GitHub Releases Link */}
            <div className="mt-12 text-center space-y-6">
              <div>
                <p className="text-sm text-muted-foreground mb-4">
                  All downloads are hosted on GitHub Releases
                </p>
                <Button asChild variant="outline">
                  <Link
                    href="https://github.com/2witstudios/PageSpace/releases"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <Github className="w-4 h-4 mr-2" />
                    View All Releases
                  </Link>
                </Button>
              </div>

              <div className="pt-8 border-t max-w-2xl mx-auto">
                <h3 className="text-lg font-semibold mb-2">Need Offline or Self-Hosted?</h3>
                <p className="text-sm text-muted-foreground mb-4">
                  The desktop app connects to PageSpace cloud. For truly offline or self-hosted deployment, run the full source code locally with your own database and services.
                </p>
                <div className="bg-muted/50 border border-muted rounded-lg p-4 mb-4">
                  <p className="text-xs text-muted-foreground">
                    <strong className="text-foreground">License Notice:</strong> PageSpace is licensed under CC-BY-NC-SA-4.0 (Creative Commons Attribution-NonCommercial-ShareAlike). You may self-host for personal or non-commercial use. Commercial use requires a separate license.{" "}
                    <Link
                      href="https://github.com/2witstudios/PageSpace/blob/master/LICENSE"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline hover:text-foreground"
                    >
                      View License
                    </Link>
                  </p>
                </div>
                <Button asChild variant="outline">
                  <Link
                    href="https://github.com/2witstudios/PageSpace"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <Github className="w-4 h-4 mr-2" />
                    View Source Code
                  </Link>
                </Button>
              </div>
            </div>
          </div>
        </section>

        <section className="w-full py-16 md:py-24 bg-background">
          <div className="container mx-auto px-4 md:px-6 max-w-4xl">
            <h2 className="text-2xl font-bold mb-6 text-center">Installation Notes</h2>
            <div className="grid gap-6 md:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">macOS Installation</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <ol className="list-decimal list-inside space-y-2 text-muted-foreground">
                    <li>Download PageSpace.dmg</li>
                    <li>Open the DMG file</li>
                    <li>Drag PageSpace to Applications folder</li>
                    <li>Launch from Applications</li>
                  </ol>
                  <p className="text-muted-foreground pt-2">
                    The app is signed and notarized, so you won&apos;t see any security warnings.
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">Windows Installation</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <ol className="list-decimal list-inside space-y-2 text-muted-foreground">
                    <li>Download PageSpace.exe</li>
                    <li>Run the installer</li>
                    <li>Click &quot;More info&quot; on SmartScreen warning</li>
                    <li>Click &quot;Run anyway&quot; to proceed</li>
                    <li>Follow the installation wizard</li>
                  </ol>
                  <p className="text-muted-foreground pt-2">
                    The SmartScreen warning is expected for unsigned apps.
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">Linux AppImage</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <ol className="list-decimal list-inside space-y-2 text-muted-foreground">
                    <li>Download PageSpace.AppImage</li>
                    <li>Make it executable: <code className="bg-muted px-1 rounded">chmod +x PageSpace.AppImage</code></li>
                    <li>Run: <code className="bg-muted px-1 rounded">./PageSpace.AppImage</code></li>
                  </ol>
                  <p className="text-muted-foreground pt-2">
                    No installation required - runs directly.
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">Linux .deb / .rpm</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <p className="text-muted-foreground mb-2">
                    <strong>Debian/Ubuntu (.deb):</strong>
                  </p>
                  <code className="block bg-muted p-2 rounded text-xs mb-4">
                    sudo dpkg -i PageSpace.deb
                  </code>
                  <p className="text-muted-foreground mb-2">
                    <strong>RedHat/Fedora (.rpm):</strong>
                  </p>
                  <code className="block bg-muted p-2 rounded text-xs">
                    sudo rpm -i PageSpace.rpm
                  </code>
                </CardContent>
              </Card>
            </div>
          </div>
        </section>
      </main>

      <footer className="w-full border-t bg-background text-foreground">
        <div className="container mx-auto flex flex-col gap-2 sm:flex-row py-6 shrink-0 items-center px-4 md:px-6">
          <p className="text-xs text-muted-foreground">
            © 2025 pagespace. All rights reserved.
          </p>
          <nav className="sm:ml-auto flex gap-4 sm:gap-6">
            <Link
              className="text-xs hover:underline underline-offset-4 text-muted-foreground"
              href="https://github.com/2witstudios/PageSpace"
              target="_blank"
              rel="noopener noreferrer"
            >
              GitHub
            </Link>
            <Link
              className="text-xs hover:underline underline-offset-4 text-muted-foreground"
              href="/downloads"
            >
              Downloads
            </Link>
            <Link
              className="text-xs hover:underline underline-offset-4 text-muted-foreground"
              href="/terms"
            >
              Terms of Service
            </Link>
            <Link
              className="text-xs hover:underline underline-offset-4 text-muted-foreground"
              href="/privacy"
            >
              Privacy
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
