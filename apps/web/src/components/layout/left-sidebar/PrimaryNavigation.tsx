"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bot, Calendar, CheckSquare, Folder, Hash, Home, MessageSquare } from "lucide-react";

import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/useAuth";
import { useLayoutStore } from "@/stores/useLayoutStore";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import { useSidebarBadges } from "@/hooks/useSidebarBadges";
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

    // Agents means "my conversations", so this href carries NO selection.
    //
    // The surface keeps its whole selection in the URL query string (see
    // useAgentSurfaceStore's "the URL is the state" design), and this link used
    // to re-attach the live selection so returning to the tab resumed whatever
    // was last open. That made the nav item the only route INTO a session and
    // no route OUT of one: `AgentsSurface` renders the conversation list only
    // while nothing is selected, and the sole things that clear a selection all
    // destroy the session first. A user parked in a session could not reach
    // their own history without ending it.
    //
    // This changes what the NAV ITEM means, not the URL-is-the-state design.
    // Deep links, refresh, popstate and the sidebar's own session rows still
    // carry and restore a full selection through the same grammar — they just
    // aren't spelled by this link any more.
    const agentsHref = buildAgentSelectionUrl({
        driveId: driveId ?? null,
        ...EMPTY_AGENT_SELECTION,
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
                // Every href here is a bare path — the Agents entry stopped
                // carrying the agent selection's query string — so `pathname`
                // (which never includes a query) compares directly. Agents
                // stays highlighted for the whole surface, selection or not,
                // because it is `exact: false` and matches on the prefix.
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
