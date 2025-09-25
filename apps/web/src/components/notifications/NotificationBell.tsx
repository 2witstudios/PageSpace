'use client';

import { useEffect } from 'react';
import { Bell } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useNotificationStore } from '@/stores/notificationStore';
import { useSocketStore } from '@/stores/socketStore';
import NotificationDropdown from './NotificationDropdown';

export default function NotificationBell() {
  const { 
    unreadCount, 
    isDropdownOpen,
    setIsDropdownOpen,
    fetchNotifications,
    initializeSocketListeners,
    cleanupSocketListeners,
  } = useNotificationStore();
  
  const { connectionStatus } = useSocketStore();

  useEffect(() => {
    // Fetch initial notifications
    fetchNotifications();
    
    // Set up Socket.IO listeners when connected
    if (connectionStatus === 'connected') {
      initializeSocketListeners();
    }
    
    return () => {
      cleanupSocketListeners();
    };
  }, [connectionStatus, fetchNotifications, initializeSocketListeners, cleanupSocketListeners]);

  return (
    <Popover open={isDropdownOpen} onOpenChange={setIsDropdownOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <Bell className="h-5 w-5" />
          {unreadCount > 0 && (
            <span className="absolute -top-1 -right-1 h-5 w-5 rounded-full bg-red-500 text-white text-xs flex items-center justify-center">
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(24rem,90vw)] max-w-sm p-0" align="end">
        <NotificationDropdown />
      </PopoverContent>
    </Popover>
  );
}