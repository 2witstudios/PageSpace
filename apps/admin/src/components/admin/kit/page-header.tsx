interface PageHeaderProps {
  title: string;
  description?: string;
  /** Right-aligned controls (range selects, refresh, export). Wraps below the title on small screens. */
  actions?: React.ReactNode;
}

/** The one page-header idiom: title + description left, actions right, wraps on mobile. */
export function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold sm:text-2xl">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
