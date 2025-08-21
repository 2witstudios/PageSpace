import Link from 'next/link';
import { Search, Home, PanelLeft, PanelRight } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useMobile } from '@/hooks/use-mobile';
import UserDropdown from '@/components/shared/UserDropdown';
import NotificationBell from '@/components/notifications/NotificationBell';

interface TopBarProps {
  onToggleLeftPanel: () => void;
  onToggleRightPanel: () => void;
}

export default function TopBar({ onToggleLeftPanel, onToggleRightPanel }: TopBarProps) {
  const isMobile = useMobile();

  return (
    <div className="flex items-center justify-between p-2 border-b bg-card text-card-foreground">
      {/* Panel Toggles, Breadcrumbs, and Global Search */}
      <div className="flex items-center space-x-4">
        <Button
          variant="ghost"
          size="icon"
          onClick={onToggleLeftPanel}
          className={isMobile ? '' : 'hidden md:block'}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <PanelLeft className="h-5 w-5" />
        </Button>
        <Link href="/dashboard" className="flex items-center text-sm text-muted-foreground">
          <Home className="h-4 w-4 mr-2" />
          <span>/</span>
        </Link>
        <div className="relative hidden md:block">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Global Search..." className="pl-8 w-96" />
        </div>
      </div>

      {/* User Controls */}
      <div className="flex items-center space-x-4">
        <div className="hidden md:block">
          <NotificationBell />
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={onToggleRightPanel}
          className={isMobile ? '' : 'hidden md:block'}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <PanelRight className="h-5 w-5" />
        </Button>
        <UserDropdown />
      </div>
    </div>
  );
}