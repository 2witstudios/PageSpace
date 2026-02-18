import { cn } from "@/lib/utils";
import { Info, AlertTriangle, CheckCircle2, Lightbulb } from "lucide-react";

const variants = {
  info: {
    icon: Info,
    border: "border-primary/20 dark:border-primary/30",
    bg: "bg-primary/5 dark:bg-primary/10",
    iconColor: "text-primary",
    textColor: "text-foreground",
  },
  warning: {
    icon: AlertTriangle,
    border: "border-amber-200 dark:border-amber-900",
    bg: "bg-amber-50/50 dark:bg-amber-950/30",
    iconColor: "text-amber-600 dark:text-amber-400",
    textColor: "text-amber-900 dark:text-amber-100",
  },
  success: {
    icon: CheckCircle2,
    border: "border-green-200 dark:border-green-900",
    bg: "bg-green-50/50 dark:bg-green-950/30",
    iconColor: "text-green-600 dark:text-green-400",
    textColor: "text-green-900 dark:text-green-100",
  },
  tip: {
    icon: Lightbulb,
    border: "border-purple-200 dark:border-purple-900",
    bg: "bg-purple-50/50 dark:bg-purple-950/30",
    iconColor: "text-purple-600 dark:text-purple-400",
    textColor: "text-purple-900 dark:text-purple-100",
  },
};

interface DocsCalloutProps {
  variant?: keyof typeof variants;
  title?: string;
  children: React.ReactNode;
}

export function DocsCallout({ variant = "info", title, children }: DocsCalloutProps) {
  const v = variants[variant];
  const Icon = v.icon;

  return (
    <div className={cn("rounded-xl border p-4 my-6", v.border, v.bg)}>
      <div className="flex items-start gap-3">
        <Icon className={cn("h-5 w-5 mt-0.5 shrink-0", v.iconColor)} />
        <div className={cn("text-sm", v.textColor)}>
          {title && <p className="font-medium mb-1">{title}</p>}
          {children}
        </div>
      </div>
    </div>
  );
}
