"use client";

import { openSearch } from "@/components/SearchDialog";

export function SearchTrigger({
  children,
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" onClick={openSearch} className={className} {...props}>
      {children}
    </button>
  );
}
