"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Calendar, CheckSquare, Home, Inbox } from "lucide-react";

import { cn } from "@/lib/utils";
import { useLayoutStore } from "@/stores/useLayoutStore";
import { useBreakpoint } from "@/hooks/useBreakpoint";

interface PrimaryNavigationProps {
    driveId?: string;
}

export default function PrimaryNavigation({ driveId }: PrimaryNavigationProps) {
    const pathname = usePathname();
    const isSheetBreakpoint = useBreakpoint("(max-width: 1023px)");
    const setLeftSheetOpen = useLayoutStore((state) => state.setLeftSheetOpen);

    const navigation = [
        {
            name: "Dashboard",
            href: "/dashboard",
            icon: Home,
            exact: true,
        },
        {
            name: "Inbox",
            href: driveId ? `/dashboard/${driveId}/inbox` : "/dashboard/inbox",
            icon: Inbox,
            exact: false,
        },
        {
            name: "Tasks",
            href: driveId ? `/dashboard/${driveId}/tasks` : "/dashboard/tasks",
            icon: CheckSquare,
            exact: false,
        },
        {
            name: "Calendar",
            href: driveId ? `/dashboard/${driveId}/calendar` : "/dashboard/calendar",
            icon: Calendar,
            exact: false,
        },
    ];

    const handleLinkClick = () => {
        if (isSheetBreakpoint) {
            setLeftSheetOpen(false);
        }
    };

    return (
        <nav className="flex flex-col gap-0.5 mb-3">
            {navigation.map((item) => {
                const isActive = item.exact
                    ? pathname === item.href
                    : pathname?.startsWith(item.href);

                return (
                    <Link
                        key={item.name}
                        href={item.href}
                        onClick={handleLinkClick}
                        className={cn(
                            "flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm font-medium transition-colors",
                            isActive
                                ? "bg-accent text-accent-foreground"
                                : "text-sidebar-foreground hover:bg-accent hover:text-accent-foreground"
                        )}
                    >
                        <item.icon className="h-4 w-4" />
                        {item.name}
                    </Link>
                );
            })}
        </nav>
    );
}
