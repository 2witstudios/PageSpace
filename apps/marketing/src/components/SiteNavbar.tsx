import Link from "next/link";
import { ChevronLeft, ChevronRight, Home, PanelLeft, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function SiteNavbar() {
  return (
    <header className="sticky top-0 z-50 pt-[env(safe-area-inset-top)] liquid-glass-thin border-b border-[var(--separator)] text-card-foreground shadow-[var(--shadow-ambient)] dark:shadow-none">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5 sm:px-4">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <div className="flex items-center">
            <Button
              variant="ghost"
              size="icon"
              className="lg:hidden"
              aria-label="Toggle navigation"
              asChild
            >
              <Link href="/"><PanelLeft className="h-5 w-5" /></Link>
            </Button>

            <Button
              variant="ghost"
              size="icon"
              className="hidden lg:flex"
              aria-label="Collapse navigation"
              asChild
            >
              <Link href="/"><PanelLeft className="h-5 w-5" /></Link>
            </Button>

            {/* NavButtons */}
            <div className="hidden sm:flex items-center">
              <Button
                variant="ghost"
                size="icon"
                disabled
                aria-label="Go back"
                className="h-8 w-8"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                disabled
                aria-label="Go forward"
                className="h-8 w-8"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <Link
            href="/"
            className="flex items-center text-sm text-gray-900 dark:text-gray-100"
            aria-label="Back to dashboard"
          >
            <Home className="mr-2 h-4 w-4" />
            <span>/</span>
          </Link>

          {/* InlineSearch */}
          <div className="hidden min-w-[200px] flex-1 md:flex">
            <div className="relative w-96">
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                <Input
                  readOnly
                  placeholder="Search... (⌘K)"
                  className="pl-8 pr-8"
                />
              </div>
            </div>
          </div>

          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            aria-label="Open search"
          >
            <Search className="h-5 w-5" />
          </Button>
        </div>

        <div className="flex flex-shrink-0 items-center gap-2">
          <Button variant="ghost" size="sm" asChild className="hidden sm:inline-flex">
            <Link href="/login">Log in</Link>
          </Button>
          <Button size="sm" asChild>
            <Link href="/signup">Get Started</Link>
          </Button>
        </div>
      </div>
    </header>
  );
}
