'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Activity,
  CreditCard,
  Database,
  FileClock,
  Gauge,
  Layers,
  LifeBuoy,
  LogOut,
  Menu,
  MessageSquareText,
  TrendingUp,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';

interface AlertState {
  errorRateAlert: boolean;
  negativeMarginAlert: boolean;
  liveHoldsAlert: boolean;
}

function isAlertState(value: unknown): value is AlertState {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.errorRateAlert === 'boolean'
    && typeof v.negativeMarginAlert === 'boolean'
    && typeof v.liveHoldsAlert === 'boolean';
}

type AlertKey = 'monitoring' | 'billing';

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  alertKey?: AlertKey;
}

interface NavGroup {
  label: string | null;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: null,
    items: [{ href: '/overview', label: 'Overview', icon: Gauge }],
  },
  {
    label: 'Analytics',
    items: [
      { href: '/growth', label: 'Growth', icon: TrendingUp },
      { href: '/monitoring', label: 'Monitoring', icon: Activity, alertKey: 'monitoring' },
    ],
  },
  {
    label: 'Billing',
    items: [
      { href: '/billing', label: 'Billing', icon: CreditCard, alertKey: 'billing' },
      { href: '/compaction', label: 'Compaction', icon: Layers },
    ],
  },
  {
    label: 'People',
    items: [
      { href: '/users', label: 'Users', icon: Users },
      { href: '/support', label: 'Support', icon: LifeBuoy },
      { href: '/audit-logs', label: 'Audit Logs', icon: FileClock },
    ],
  },
  {
    label: 'System',
    items: [
      { href: '/tables', label: 'Database', icon: Database },
      { href: '/global-prompt', label: 'Global Prompt', icon: MessageSquareText },
    ],
  },
];

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function AlertDot() {
  return <span className="ml-auto inline-flex h-2 w-2 shrink-0 rounded-full bg-red-500" aria-label="Attention needed" />;
}

function NavLinks({ pathname, alerts, onNavigate }: {
  pathname: string;
  alerts: AlertState | null;
  onNavigate?: () => void;
}) {
  const alertFor = (key?: AlertKey) =>
    key === 'monitoring' ? alerts?.errorRateAlert
    : key === 'billing' ? (alerts?.negativeMarginAlert || alerts?.liveHoldsAlert)
    : false;

  return (
    <nav className="flex flex-col gap-4 p-3" aria-label="Admin sections">
      {NAV_GROUPS.map((group) => (
        <div key={group.label ?? 'root'}>
          {group.label && (
            <p className="px-3 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{group.label}</p>
          )}
          <div className="flex flex-col gap-0.5">
            {group.items.map((item) => {
              const active = isActive(pathname, item.href);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={onNavigate}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex min-h-10 items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors',
                    active
                      ? 'bg-primary/10 font-medium text-primary'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" aria-hidden />
                  <span className="truncate">{item.label}</span>
                  {alertFor(item.alertKey) && <AlertDot />}
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}

export default function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [alerts, setAlerts] = useState<AlertState | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const loadAlerts = () => {
      fetchWithAuth('/api/admin/alerts')
        .then(async (r): Promise<unknown> => (r.ok ? r.json() : null))
        .then((d) => { if (!cancelled && isAlertState(d)) setAlerts(d); })
        .catch(() => null);
    };
    loadAlerts();
    const id = setInterval(() => { if (!document.hidden) loadAlerts(); }, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // Close the drawer on navigation and lock body scroll while it is open.
  useEffect(() => { setDrawerOpen(false); }, [pathname]);
  useEffect(() => {
    document.body.style.overflow = drawerOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [drawerOpen]);

  const signOut = async () => {
    setSigningOut(true);
    try {
      await fetchWithAuth('/api/auth/logout', { method: 'POST' });
    } finally {
      router.push('/login');
      router.refresh();
    }
  };

  const currentLabel = NAV_GROUPS.flatMap((g) => g.items).find((i) => isActive(pathname, i.href))?.label ?? 'Admin';

  return (
    <div className="flex min-h-screen bg-background">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r bg-card lg:flex">
        <div className="flex h-14 items-center gap-2 border-b px-5">
          <span className="text-sm font-semibold">PageSpace Admin</span>
        </div>
        <div className="flex-1 overflow-y-auto">
          <NavLinks pathname={pathname} alerts={alerts} />
        </div>
        <div className="border-t p-3">
          <Button variant="ghost" className="w-full justify-start gap-2.5 text-muted-foreground" onClick={signOut} disabled={signingOut}>
            <LogOut className="h-4 w-4" aria-hidden />
            {signingOut ? 'Signing out…' : 'Sign out'}
          </Button>
        </div>
      </aside>

      {/* Mobile drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <button
            type="button"
            aria-label="Close navigation"
            className="absolute inset-0 bg-black/50"
            onClick={() => setDrawerOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col border-r bg-card shadow-xl">
            <div className="flex h-14 items-center justify-between border-b px-4">
              <span className="text-sm font-semibold">PageSpace Admin</span>
              <Button variant="ghost" size="icon" className="h-10 w-10" onClick={() => setDrawerOpen(false)} aria-label="Close navigation">
                <X className="h-5 w-5" />
              </Button>
            </div>
            <div className="flex-1 overflow-y-auto">
              <NavLinks pathname={pathname} alerts={alerts} onNavigate={() => setDrawerOpen(false)} />
            </div>
            <div className="border-t p-3">
              <Button variant="ghost" className="w-full justify-start gap-2.5 text-muted-foreground" onClick={signOut} disabled={signingOut}>
                <LogOut className="h-4 w-4" aria-hidden />
                {signingOut ? 'Signing out…' : 'Sign out'}
              </Button>
            </div>
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile header */}
        <header className="sticky top-0 z-40 flex h-14 items-center gap-2 border-b bg-background/95 px-3 backdrop-blur lg:hidden">
          <Button variant="ghost" size="icon" className="h-10 w-10" onClick={() => setDrawerOpen(true)} aria-label="Open navigation">
            <Menu className="h-5 w-5" />
          </Button>
          <span className="truncate text-sm font-semibold">{currentLabel}</span>
        </header>

        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 lg:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}
