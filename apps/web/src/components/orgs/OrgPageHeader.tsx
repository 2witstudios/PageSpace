'use client';

import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';

/** The canvas page head: a back link, the title, and one line of description. */
export function OrgPageHeader({ backHref, backLabel, title, description }: { backHref: string; backLabel: string; title: string; description?: React.ReactNode }) {
  return (
    <div className="mb-8">
      <Button variant="ghost" size="sm" asChild className="mb-4">
        <Link href={backHref}>
          <ChevronLeft className="mr-1 h-4 w-4" />
          {backLabel}
        </Link>
      </Button>
      <h1 className="mb-2 text-3xl font-bold">{title}</h1>
      {description ? <p className="text-muted-foreground">{description}</p> : null}
    </div>
  );
}

/** The width every org page uses: max-w-2xl for the hub, wider for tables (canvas .container.wide). */
export function OrgPageContainer({ wide = false, children }: { wide?: boolean; children: React.ReactNode }) {
  return <div className={`container mx-auto px-4 py-10 sm:px-6 lg:px-10 ${wide ? 'max-w-4xl' : 'max-w-2xl'}`}>{children}</div>;
}
