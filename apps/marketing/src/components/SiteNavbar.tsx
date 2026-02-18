import Link from "next/link";
import Image from "next/image";
import { Search } from "lucide-react";
import { SearchTrigger } from "@/components/SearchTrigger";
import { ThemeToggle } from "@/components/ThemeToggle";
import { NavbarAuthButtons } from "@/components/NavbarAuthButtons";

const navLinks = [
  { href: "/pricing", label: "Pricing" },
  { href: "/docs", label: "Docs" },
  { href: "/blog", label: "Blog" },
  { href: "/faq", label: "FAQ" },
];

export function SiteNavbar() {
  return (
    <header className="sticky top-0 z-50 pt-[env(safe-area-inset-top)] liquid-glass-thin border-b border-[var(--separator)] text-card-foreground shadow-[var(--shadow-ambient)] dark:shadow-none">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5 sm:px-4">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {/* Logo */}
          <Link
            href="/"
            className="flex items-center gap-2 text-sm"
            aria-label="PageSpace home"
          >
            <Image
              src="/android-chrome-192x192.png"
              alt="PageSpace"
              width={20}
              height={20}
              className="rounded"
            />
            <span className="font-semibold text-gray-900 dark:text-gray-100">PageSpace</span>
          </Link>
          <span className="text-muted-foreground">/</span>

          {/* Search trigger (desktop) */}
          <div className="hidden min-w-[200px] flex-1 md:flex">
            <SearchTrigger className="relative w-96 flex items-center rounded-md border border-input bg-transparent px-3 py-1.5 text-sm text-muted-foreground shadow-xs hover:bg-accent transition-colors cursor-pointer">
              <Search className="mr-2 h-4 w-4" />
              <span className="flex-1 text-left">Search...</span>
              <kbd className="ml-auto hidden sm:inline-flex h-5 items-center gap-0.5 rounded border border-border bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">
                <span>⌘</span>K
              </kbd>
            </SearchTrigger>
          </div>

          {/* Search trigger (mobile) */}
          <SearchTrigger className="inline-flex items-center justify-center h-9 w-9 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors md:hidden" aria-label="Open search">
            <Search className="h-5 w-5" />
          </SearchTrigger>
        </div>

        {/* Center: Nav Links */}
        <nav className="hidden md:flex items-center gap-1">
          {navLinks.map(({ href, label }) => (
            <Link
              key={href}
              href={href}
              className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors rounded-md hover:bg-accent"
            >
              {label}
            </Link>
          ))}
        </nav>

        <div className="flex flex-shrink-0 items-center gap-2">
          <ThemeToggle />
          <NavbarAuthButtons />
        </div>
      </div>
    </header>
  );
}
