'use client';
import { Button } from '@/retained/components/ui/button';
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '@/retained/components/ui/dialog';
import SidebarActivityTab from '@/retained/components/layout/right-sidebar/ai-assistant/SidebarActivityTab';
export function PageHistory() {
  return <Dialog><DialogTrigger asChild><Button variant="ghost" size="sm">History</Button></DialogTrigger>
    <DialogContent className="flex h-[80vh] flex-col overflow-hidden"><DialogTitle>Page history</DialogTitle>
      <div className="min-h-0 flex-1"><SidebarActivityTab /></div>
    </DialogContent></Dialog>;
}
