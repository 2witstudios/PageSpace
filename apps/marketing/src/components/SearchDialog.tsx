"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { FileText, BookOpen, HelpCircle, Globe } from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { searchEntries, type SearchEntry } from "@/lib/search-data";

const categoryIcons: Record<SearchEntry["category"], React.ReactNode> = {
  Docs: <BookOpen className="h-4 w-4 text-primary" />,
  Blog: <FileText className="h-4 w-4 text-green-500" />,
  FAQ: <HelpCircle className="h-4 w-4 text-amber-500" />,
  Pages: <Globe className="h-4 w-4 text-muted-foreground" />,
};

const groupOrder: SearchEntry["category"][] = ["Docs", "Blog", "FAQ", "Pages"];

export function SearchDialog() {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  // Cmd+K / Ctrl+K
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // Custom event so other components can open the dialog
  useEffect(() => {
    function onOpenSearch() {
      setOpen(true);
    }
    document.addEventListener("open-search", onOpenSearch);
    return () => document.removeEventListener("open-search", onOpenSearch);
  }, []);

  const handleSelect = useCallback(
    (href: string) => {
      setOpen(false);
      router.push(href);
    },
    [router]
  );

  // Group entries by category
  const grouped = groupOrder
    .map((cat) => ({
      category: cat,
      entries: searchEntries.filter((e) => e.category === cat),
    }))
    .filter((g) => g.entries.length > 0);

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Search"
      description="Search docs, blog posts, and more."
    >
      <CommandInput placeholder="Search docs, blog, FAQ..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        {grouped.map((group) => (
          <CommandGroup key={group.category} heading={group.category}>
            {group.entries.map((entry) => (
              <CommandItem
                key={entry.href + entry.title}
                value={[entry.title, entry.description, entry.keywords]
                  .filter(Boolean)
                  .join(" ")}
                onSelect={() => handleSelect(entry.href)}
              >
                {categoryIcons[entry.category]}
                <div className="flex flex-col gap-0.5 min-w-0">
                  <span className="text-sm font-medium truncate">
                    {entry.title}
                  </span>
                  <span className="text-xs text-muted-foreground truncate">
                    {entry.description}
                  </span>
                </div>
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  );
}

/** Call from any component to open the search dialog */
export function openSearch() {
  document.dispatchEvent(new CustomEvent("open-search"));
}
