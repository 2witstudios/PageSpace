"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bot, Calendar, CheckSquare, Folder, Hash, Home, MessageSquare } from "lucide-react";

import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/useAuth";
import { useLayoutStore } from "@/stores/useLayoutStore";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import { useSidebarBadges } from "@/hooks/useSidebarBadges";
import { useShallow } from "zustand/react/shallow";
import { useAgentSurfaceStore } from "@/stores/agents/useAgentSurfaceStore";
import { EMPTY_AGENT_SELECTION, buildAgentSelectionUrl } from "@/lib/agents/agent-selection";

interface PrimaryNavigationProps {
    driveId?: string;
}

export default function PrimaryNavigation({ driveId }: PrimaryNavigationProps) {
    const pathname = usePathname();
    const isSheetBreakpoint = useBreakpoint("(max-width: 1023px)");
    const setLeftSheetOpen = useLayoutStore((state) => state.setLeftSheetOpen);
    const badges = useSidebarBadges();
    const { user } = useAuth();
    // Sessions/chat/panes are open to every authenticated user — only the
    // sandbox itself (real cloud compute) is tier-gated, server-side, and
    // that gate lives on the terminal affordance inside a session, not on
    // nav-item visibility.
    const isAuthenticated = Boolean(user);

    // The Agents surface keeps its whole selection in the URL query string
    // (see useAgentSurfaceStore's "the URL is the state" design) and never
    // clears it on route unmount, so the store still has the right values in
    // memory even after navigating away. A bare href here would silently drop
    // them on the way back in — derive the link's href from the live
    // selection instead, scoped to this nav's own drive so a different
    // drive's (or global vs. drive-scoped) session is never carried over.
    const agentsSelectionDriveId = useAgentSurfaceStore((state) => state.driveId);
    const agentSelection = useAgentSurfaceStore(
        useShallow((state) => ({
            sessionId: state.selectedSessionId,
            conversationId: state.selectedConversationId,
            agentId: state.selectedAgentId,
        }))
    );
    const agentsTargetDriveId = driveId ?? null;
    const agentsMatchesDrive = agentsSelectionDriveId === agentsTargetDriveId;
    const agentsHref = buildAgentSelectionUrl({
        driveId: agentsTargetDriveId,
        ...(agentsMatchesDrive ? agentSelection : EMPTY_AGENT_SELECTION),
    });

    const navigation = [
        {
            name: driveId ? "Drive Home" : "Dashboard",
            href: driveId ? `/dashboard/${driveId}` : "/dashboard",
            icon: Home,
            exact: true,
            badge: 0,
        },
        // DMs are user-scoped — same href in drive nav so they're always one click away.
        {
            name: "Direct Messages",
            href: "/dashboard/dms",
            icon: MessageSquare,
            exact: false,
            badge: badges.dms,
        },
        {
            name: "Channels",
            href: driveId ? `/dashboard/${driveId}/channels` : "/dashboard/channels",
            icon: Hash,
            exact: false,
            badge: badges.channels,
        },
        {
            name: "Files",
            href: driveId ? `/dashboard/${driveId}/files` : "/dashboard/drives",
            icon: Folder,
            exact: false,
            badge: badges.files,
        },
        {
            name: "Tasks",
            href: driveId ? `/dashboard/${driveId}/tasks` : "/dashboard/tasks",
            icon: CheckSquare,
            exact: false,
            badge: badges.tasks,
        },
        {
            name: "Calendar",
            href: driveId ? `/dashboard/${driveId}/calendar` : "/dashboard/calendar",
            icon: Calendar,
            exact: false,
            badge: badges.calendar,
        },
        // Both hrefs are real views: the driveless one aggregates every
        // accessible drive's agents, the drive-scoped one shows just that
        // drive's. Neither redirects to the other.
        ...(isAuthenticated
            ? [{
                name: "Agents",
                href: agentsHref,
                icon: Bot,
                exact: false,
                badge: 0,
            }]
            : []),
    ];

    const handleLinkClick = () => {
        if (isSheetBreakpoint) {
            setLeftSheetOpen(false);
        }
    };

    return (
        <nav className="flex flex-col gap-0.5 mb-2">
            {navigation.map((item) => {
                // The Agents entry's href can carry a query string (the live
                // agent-session selection); isActive must compare against the
                // bare path, since usePathname() never includes the query
                // string. Every other item's href never has a "?", so this
                // is a no-op for them.
                const matchPath = item.href.split("?")[0];
                const isActive = item.exact
                    ? pathname === matchPath
                    : pathname?.startsWith(matchPath);

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
                        <item.icon className="h-4 w-4 shrink-0" />
                        {item.name}
                        {item.badge > 0 && (
                            <span className="ml-auto inline-flex items-center justify-center h-4 min-w-[16px] px-1 rounded-full bg-primary text-primary-foreground text-[10px] font-medium tabular-nums">
                                {item.badge > 99 ? "99+" : item.badge}
                            </span>
                        )}
                    </Link>
                );
            })}
        </nav>
    );
}
