"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { docsNav, type NavSection } from "@/app/docs/docs-nav";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetTrigger, SheetTitle } from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import { Menu } from "lucide-react";

function SidebarSection({ section, pathname }: { section: NavSection; pathname: string }) {
  const isActive = section.items.some((item) => item.href === pathname);
  const [open, setOpen] = useState(isActive);
  const Icon = section.icon;

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-3 py-2 text-sm font-medium text-foreground hover:bg-muted/50 rounded-lg transition-colors"
      >
        <span className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-muted-foreground" />
          {section.title}
        </span>
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 text-muted-foreground transition-transform",
            open && "rotate-180"
          )}
        />
      </button>
      {open && (
        <ul className="mt-1 ml-3 space-y-0.5 border-l border-border pl-3">
          {section.items.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={pathname === item.href ? "page" : undefined}
                className={cn(
                  "block rounded-md px-3 py-1.5 text-sm transition-colors",
                  pathname === item.href
                    ? "bg-primary/10 text-primary font-medium"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                )}
              >
                {item.title}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SidebarContent() {
  const pathname = usePathname();

  return (
    <ScrollArea className="h-full">
      <div className="space-y-1 py-4 pr-2">
        {docsNav.map((section) => (
          <SidebarSection key={section.title} section={section} pathname={pathname} />
        ))}
      </div>
    </ScrollArea>
  );
}

export function DocsSidebar() {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <button aria-label="Open navigation" className="fixed bottom-4 left-4 z-50 flex h-12 w-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg md:hidden">
            <Menu className="h-5 w-5" />
          </button>
        </SheetTrigger>
        <SheetContent side="left" className="w-72 p-4">
          <SheetTitle className="text-base font-semibold mb-2">Documentation</SheetTitle>
          <div onClick={(e) => {
            if ((e.target as HTMLElement).closest("a")) {
              setOpen(false);
            }
          }}>
            <SidebarContent />
          </div>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <aside className="hidden md:block w-60 shrink-0 sticky top-16 h-[calc(100vh-4rem)] overflow-hidden">
      <SidebarContent />
    </aside>
  );
}
