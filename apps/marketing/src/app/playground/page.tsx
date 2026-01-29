"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, Moon, Sun, Palette } from "lucide-react";
import { useTheme } from "next-themes";
import { cn } from "@/lib/utils";

export default function PlaygroundPage() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  // Prevent hydration mismatch
  useState(() => {
    setMounted(true);
  });

  const colors = [
    { name: "Primary", var: "--primary", class: "bg-primary" },
    { name: "Secondary", var: "--secondary", class: "bg-secondary" },
    { name: "Accent", var: "--accent", class: "bg-accent" },
    { name: "Muted", var: "--muted", class: "bg-muted" },
    { name: "Destructive", var: "--destructive", class: "bg-destructive" },
    { name: "Success", var: "--success", class: "bg-success" },
    { name: "Warning", var: "--warning", class: "bg-warning" },
    { name: "Info", var: "--info", class: "bg-info" },
  ];

  const typography = [
    { name: "Display", class: "text-7xl font-bold", text: "Display" },
    { name: "H1", class: "text-5xl font-bold", text: "Heading 1" },
    { name: "H2", class: "text-4xl font-semibold", text: "Heading 2" },
    { name: "H3", class: "text-3xl font-semibold", text: "Heading 3" },
    { name: "H4", class: "text-2xl font-medium", text: "Heading 4" },
    { name: "Body Large", class: "text-lg", text: "Body text large" },
    { name: "Body", class: "text-base", text: "Body text regular" },
    { name: "Small", class: "text-sm", text: "Small text" },
    { name: "Caption", class: "text-xs text-muted-foreground", text: "Caption text" },
  ];

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border sticky top-0 bg-background/80 backdrop-blur z-50">
        <div className="container mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div>
              <Link
                href="/"
                className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors mb-2"
              >
                <ArrowLeft className="w-4 h-4" />
                Back to Home
              </Link>
              <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
                <Palette className="w-6 h-6" />
                Design Playground
              </h1>
            </div>
            {mounted && (
              <button
                onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
                className="p-3 rounded-lg border border-border hover:bg-accent transition-colors"
              >
                {theme === "dark" ? (
                  <Sun className="w-5 h-5" />
                ) : (
                  <Moon className="w-5 h-5" />
                )}
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="container mx-auto px-6 py-8 space-y-12">
        {/* Color Palette */}
        <section>
          <h2 className="text-xl font-semibold mb-6">Color Palette</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {colors.map((color) => (
              <div key={color.name} className="space-y-2">
                <div
                  className={cn(
                    "h-24 rounded-xl border border-border",
                    color.class
                  )}
                />
                <div className="text-sm font-medium text-foreground">{color.name}</div>
                <div className="text-xs text-muted-foreground font-mono">{color.var}</div>
              </div>
            ))}
          </div>
        </section>

        {/* Typography Scale */}
        <section>
          <h2 className="text-xl font-semibold mb-6">Typography Scale</h2>
          <div className="space-y-6 p-6 rounded-xl border border-border bg-card">
            {typography.map((item) => (
              <div key={item.name} className="flex items-baseline gap-4">
                <span className="w-24 text-sm text-muted-foreground">{item.name}</span>
                <span className={cn("text-foreground", item.class)}>{item.text}</span>
              </div>
            ))}
          </div>
        </section>

        {/* UI Components */}
        <section>
          <h2 className="text-xl font-semibold mb-6">UI Components</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Buttons */}
            <div className="p-6 rounded-xl border border-border bg-card">
              <h3 className="font-medium mb-4">Buttons</h3>
              <div className="flex flex-wrap gap-3">
                <button className="px-4 py-2 rounded-lg bg-primary text-primary-foreground font-medium hover:opacity-90 transition-opacity">
                  Primary
                </button>
                <button className="px-4 py-2 rounded-lg bg-secondary text-secondary-foreground font-medium hover:opacity-90 transition-opacity">
                  Secondary
                </button>
                <button className="px-4 py-2 rounded-lg border border-border text-foreground font-medium hover:bg-accent transition-colors">
                  Outline
                </button>
                <button className="px-4 py-2 rounded-lg text-foreground font-medium hover:bg-accent transition-colors">
                  Ghost
                </button>
              </div>
            </div>

            {/* Cards */}
            <div className="p-6 rounded-xl border border-border bg-card">
              <h3 className="font-medium mb-4">Cards</h3>
              <div className="space-y-3">
                <div className="p-4 rounded-lg bg-muted">
                  <div className="font-medium text-foreground">Muted Card</div>
                  <div className="text-sm text-muted-foreground">With subtle background</div>
                </div>
                <div className="p-4 rounded-lg border border-border bg-card">
                  <div className="font-medium text-foreground">Bordered Card</div>
                  <div className="text-sm text-muted-foreground">With border styling</div>
                </div>
              </div>
            </div>

            {/* Badges */}
            <div className="p-6 rounded-xl border border-border bg-card">
              <h3 className="font-medium mb-4">Badges</h3>
              <div className="flex flex-wrap gap-2">
                <span className="px-3 py-1 rounded-full bg-primary text-primary-foreground text-sm font-medium">
                  Primary
                </span>
                <span className="px-3 py-1 rounded-full bg-success text-white text-sm font-medium">
                  Success
                </span>
                <span className="px-3 py-1 rounded-full bg-warning text-white text-sm font-medium">
                  Warning
                </span>
                <span className="px-3 py-1 rounded-full bg-destructive text-white text-sm font-medium">
                  Destructive
                </span>
                <span className="px-3 py-1 rounded-full bg-info text-white text-sm font-medium">
                  Info
                </span>
              </div>
            </div>

            {/* Inputs */}
            <div className="p-6 rounded-xl border border-border bg-card">
              <h3 className="font-medium mb-4">Inputs</h3>
              <div className="space-y-3">
                <input
                  type="text"
                  placeholder="Text input..."
                  className="w-full px-4 py-2.5 rounded-lg border border-input bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <textarea
                  placeholder="Textarea..."
                  rows={3}
                  className="w-full px-4 py-2.5 rounded-lg border border-input bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring resize-none"
                />
              </div>
            </div>
          </div>
        </section>

        {/* Liquid Glass Effects */}
        <section>
          <h2 className="text-xl font-semibold mb-6">Liquid Glass Effects</h2>
          <div className="relative h-64 rounded-xl overflow-hidden bg-gradient-to-br from-primary/20 via-accent/20 to-secondary/20">
            <div className="absolute inset-0 flex items-center justify-center gap-6 p-6">
              <div className="liquid-glass-thin p-6 rounded-xl">
                <div className="font-medium text-foreground">Thin</div>
                <div className="text-sm text-muted-foreground">Subtle blur</div>
              </div>
              <div className="liquid-glass-regular p-6 rounded-xl">
                <div className="font-medium text-foreground">Regular</div>
                <div className="text-sm text-muted-foreground">Standard material</div>
              </div>
              <div className="liquid-glass-thick p-6 rounded-xl">
                <div className="font-medium text-foreground">Thick</div>
                <div className="text-sm text-muted-foreground">Heavy blur</div>
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
