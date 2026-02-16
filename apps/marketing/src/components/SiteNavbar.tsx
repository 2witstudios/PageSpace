import Link from "next/link";
import Image from "next/image";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const navLinks = [
  { href: "/tour", label: "Product" },
  { href: "/pricing", label: "Pricing" },
  { href: "/docs", label: "Docs" },
  { href: "/blog", label: "Blog" },
  { href: "/changelog", label: "Changelog" },
];

export function SiteNavbar() {
  return (
    <header className="sticky top-0 z-50 pt-[env(safe-area-inset-top)] liquid-glass-thin border-b border-[var(--separator)] text-card-foreground shadow-[var(--shadow-ambient)] dark:shadow-none">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5 sm:px-4">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {/* Logo + Search */}
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
