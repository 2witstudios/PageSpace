"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { LucideIcon } from "lucide-react";

interface SettingsSectionProps {
  title: string;
  description?: string;
  icon?: LucideIcon;
  iconColor?: string;
  children: React.ReactNode;
  className?: string;
  variant?: "default" | "danger";
  action?: React.ReactNode;
}

export function SettingsSection({
  title,
  description,
  icon: Icon,
  iconColor,
  children,
  className,
  variant = "default",
  action,
}: SettingsSectionProps) {
  return (
    <Card
      className={cn(
        "mb-6",
        variant === "danger" && "border-destructive/50",
        className
      )}
    >
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {Icon && <Icon className={cn("h-5 w-5", iconColor)} />}
            <div>
              <CardTitle className={cn(variant === "danger" && "text-destructive")}>
                {title}
              </CardTitle>
              {description && <CardDescription>{description}</CardDescription>}
            </div>
          </div>
          {action}
        </div>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}
