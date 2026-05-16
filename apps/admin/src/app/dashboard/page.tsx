"use client";

import Link from "next/link";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Activity, Database, MessageSquare, Users, Headphones } from "lucide-react";

interface AdminSection {
  title: string;
  description: string;
  icon: typeof Activity;
  href: string;
}

const adminSections: AdminSection[] = [
  {
    title: "Monitoring",
    description: "System monitoring dashboard",
    icon: Activity,
    href: "/admin/monitoring",
  },
  {
    title: "Database Tables",
    description: "Database schema visualization",
    icon: Database,
    href: "/admin/tables",
  },
  {
    title: "Global Prompt",
    description: "Global AI prompt management",
    icon: MessageSquare,
    href: "/admin/global-prompt",
  },
  {
    title: "User Management",
    description: "Manage users and permissions",
    icon: Users,
    href: "/admin/users",
  },
  {
    title: "Support",
    description: "Support tools and requests",
    icon: Headphones,
    href: "/admin/support",
  },
];

export default function AdminPage() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {adminSections.map((section) => (
        <Link key={section.href} href={section.href}>
          <Card className="transition-colors hover:bg-accent h-full">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <section.icon className="h-5 w-5" />
                {section.title}
              </CardTitle>
              <CardDescription>{section.description}</CardDescription>
            </CardHeader>
          </Card>
        </Link>
      ))}
    </div>
  );
}
