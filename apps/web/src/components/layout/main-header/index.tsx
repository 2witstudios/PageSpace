import Link from 'next/link';
import { Home, PanelLeft, PanelRight, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useMobile } from '@/hooks/use-mobile';
import UserDropdown from '@/components/shared/UserDropdown';
import NotificationBell from '@/components/notifications/NotificationBell';
import InlineSearch from '@/components/search/InlineSearch';
import GlobalSearch from '@/components/search/GlobalSearch';
import { useState } from 'react';

interface TopBarProps {
  onToggleLeftPanel: () => void;
  onToggleRightPanel: () => void;
}

export default function TopBar({ onToggleLeftPanel, onToggleRightPanel }: TopBarProps) {
  const isMobile = useMobile();
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);

  return (
    <>
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
          {/* Desktop search - inline functional input */}
          <div className="hidden md:block">
            <InlineSearch />
          </div>
          {/* Mobile search - opens full dialog */}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setMobileSearchOpen(true)}
            className="md:hidden"
          >
            <Search className="h-5 w-5" />
          </Button>
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

      {/* Mobile Search Dialog */}
      <GlobalSearch open={mobileSearchOpen} onOpenChange={setMobileSearchOpen} />
    </>
  );
}