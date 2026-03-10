"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ArrowLeft, LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface SettingsPageLayoutProps {
  title: string;
  description?: string;
  icon?: LucideIcon;
  iconColor?: string;
  children: React.ReactNode;
  maxWidth?: "sm" | "md" | "lg" | "xl" | "2xl" | "4xl";
  backHref?: string;
  className?: string;
}

const maxWidthClasses = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-lg",
  xl: "max-w-xl",
  "2xl": "max-w-2xl",
  "4xl": "max-w-4xl",
};

export function SettingsPageLayout({
  title,
  description,
  icon: Icon,
  iconColor,
  children,
  maxWidth = "2xl",
  backHref = "/settings",
  className,
}: SettingsPageLayoutProps) {
  const router = useRouter();

  return (
    <div className={cn("container mx-auto py-10 px-4 sm:px-6 lg:px-10", maxWidthClasses[maxWidth], className)}>
      <div className="mb-8">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push(backHref)}
          className="mb-4"
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Settings
        </Button>
        <div className="flex items-center gap-3">
          {Icon && (
            <div className="p-2 rounded-lg bg-primary/10">
              <Icon className={cn("h-6 w-6", iconColor || "text-primary")} />
            </div>
          )}
          <div>
            <h1 className="text-2xl font-bold">{title}</h1>
            {description && (
              <p className="text-muted-foreground">{description}</p>
            )}
          </div>
        </div>
      </div>
      <div className="space-y-6">
        {children}
      </div>
    </div>
  );
}
