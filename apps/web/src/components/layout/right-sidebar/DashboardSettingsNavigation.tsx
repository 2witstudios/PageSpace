'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { cn } from '@/lib/utils';
import { Key, Plug2, User } from 'lucide-react';

export default function DashboardSettingsNavigation() {
  const pathname = usePathname();

  const settingsCategories = [
    {
      id: 'ai-settings',
      title: 'AI Settings',
      icon: Key,
      defaultOpen: true,
      items: [
        {
          title: 'AI API Keys',
          href: '/dashboard/settings/ai-api',
          icon: Key,
        },
        {
          title: 'MCP Connection',
          href: '/dashboard/settings/mcp',
          icon: Plug2,
        },
      ],
    },
    {
      id: 'profile',
      title: 'Profile',
      icon: User,
      defaultOpen: false,
      items: [
        // Placeholder for future settings
      ],
    },
  ];

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 border-b">
        <h2 className="text-lg font-semibold">Settings</h2>
      </div>
      <div className="flex-1 overflow-auto p-4">
        <Accordion 
          type="multiple" 
          defaultValue={settingsCategories.filter(cat => cat.defaultOpen).map(cat => cat.id)}
          className="w-full"
        >
          {settingsCategories.map((category) => (
            <AccordionItem key={category.id} value={category.id} className="border-b">
              <AccordionTrigger className="py-3 hover:no-underline">
                <div className="flex items-center gap-2">
                  <category.icon className="h-4 w-4" />
                  <span className="font-medium">{category.title}</span>
                </div>
              </AccordionTrigger>
              <AccordionContent className="pt-0 pb-4">
                <div className="space-y-1">
                  {category.items.length > 0 ? (
                    category.items.map((item) => (
                      <Link
                        key={item.href}
                        href={item.href}
                        className={cn(
                          'flex items-center gap-3 px-3 py-2 text-sm rounded-md transition-colors hover:bg-accent hover:text-accent-foreground',
                          pathname === item.href && 'bg-accent text-accent-foreground'
                        )}
                      >
                        <item.icon className="h-4 w-4" />
                        {item.title}
                      </Link>
                    ))
                  ) : (
                    <p className="px-3 py-2 text-sm text-muted-foreground">
                      No settings available yet
                    </p>
                  )}
                </div>
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    </div>
  );
}