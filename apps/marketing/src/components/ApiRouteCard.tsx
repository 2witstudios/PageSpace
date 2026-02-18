import { cn } from "@/lib/utils";

const methodColors: Record<string, string> = {
  GET: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  POST: "bg-primary/10 text-primary dark:bg-primary/20 dark:text-primary",
  PATCH: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  PUT: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  DELETE: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
};

interface ApiRouteCardProps {
  method: string;
  path: string;
  description: string;
  auth?: string;
}

export function ApiRouteCard({ method, path, description, auth = "Required" }: ApiRouteCardProps) {
  return (
    <div className="rounded-lg border border-border p-4 my-3">
      <div className="flex items-center gap-3 mb-2">
        <span
          className={cn(
            "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-bold",
            methodColors[method] || "bg-muted text-muted-foreground"
          )}
        >
          {method}
        </span>
        <code className="text-sm font-mono text-foreground">{path}</code>
      </div>
      <p className="text-sm text-muted-foreground">{description}</p>
      {auth && (
        <p className="text-xs text-muted-foreground mt-1">Auth: {auth}</p>
      )}
    </div>
  );
}

interface ApiRouteSectionProps {
  title: string;
  routes: ApiRouteCardProps[];
}

export function ApiRouteSection({ title, routes }: ApiRouteSectionProps) {
  return (
    <div className="my-8">
      <h3 className="text-lg font-semibold mb-3">{title}</h3>
      {routes.map((route, i) => (
        <ApiRouteCard key={`${route.method}-${route.path}-${i}`} {...route} />
      ))}
    </div>
  );
}
