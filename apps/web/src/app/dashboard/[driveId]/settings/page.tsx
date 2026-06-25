'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ChevronLeft, Shield, Users, Brain, Cable, HardDrive, Trash2, SlashSquare, Globe } from 'lucide-react';
import { useDriveStore } from '@/hooks/useDrive';
import { SettingsRow, type SettingsItem } from '@/app/settings/SettingsRow';

interface SettingsSection {
  title: string;
  items: SettingsItem[];
}

export default function DriveSettingsPage() {
  const params = useParams();
  const router = useRouter();
  const driveId = params.driveId as string;
  const drives = useDriveStore((state) => state.drives);
  const isLoading = useDriveStore((state) => state.isLoading);
  const fetchDrives = useDriveStore((state) => state.fetchDrives);

  useEffect(() => {
    fetchDrives();
  }, [fetchDrives]);

  const drive = drives.find((d) => d.id === driveId);
  const canManage = drive?.isOwned || drive?.role === 'ADMIN';

  const commandsItems: SettingsItem[] = [
    {
      title: 'Commands',
      description: 'Slash commands for everyone in this drive',
      icon: SlashSquare,
      href: `/dashboard/${driveId}/settings/commands`,
      available: true,
    },
  ];

  if (isLoading) {
    return (
      <div className="container mx-auto px-4 py-10 sm:px-6 lg:px-10 max-w-2xl">
        <Skeleton className="h-8 w-48 mb-2" />
        <Skeleton className="h-4 w-64 mb-8" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!drive) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-muted-foreground">Drive not found</p>
      </div>
    );
  }

  // Plain members see only the Commands row; everything else is owner/admin-only.
  const settingsSections: SettingsSection[] = !canManage
    ? [{ title: 'Drive', items: commandsItems }]
    : [
        {
          title: 'Drive',
          items: [
            {
              title: 'General',
              description: 'Drive name and member overview',
              icon: Shield,
              href: `/dashboard/${driveId}/settings/general`,
              available: true,
            },
            {
              title: 'Domains & Publishing',
              description: 'Custom domains for your published site',
              icon: Globe,
              href: `/dashboard/${driveId}/settings/domains`,
              available: true,
            },
            {
              title: 'Roles',
              description: 'Custom roles and permissions',
              icon: Users,
              href: `/dashboard/${driveId}/settings/roles`,
              available: true,
            },
            {
              title: 'Context',
              description: 'Workspace memory for AI',
              icon: Brain,
              href: `/dashboard/${driveId}/settings/context`,
              available: true,
            },
            ...commandsItems,
          ],
        },
        {
          title: 'Connections',
          items: [
            {
              title: 'Integrations',
              description: 'External services and API connections',
              icon: Cable,
              href: `/dashboard/${driveId}/settings/integrations`,
              available: true,
            },
          ],
        },
        {
          title: 'Data',
          items: [
            {
              title: 'Backups',
              description: 'Snapshots of pages, members, and roles',
              icon: HardDrive,
              href: `/dashboard/${driveId}/settings/backups`,
              available: true,
            },
          ],
        },
        ...(drive.isOwned
          ? [
              {
                title: 'Administration',
                items: [
                  {
                    title: 'Danger Zone',
                    description: 'Delete or transfer this drive',
                    icon: Trash2,
                    href: `/dashboard/${driveId}/settings/danger`,
                    available: true,
                  },
                ],
              },
            ]
          : []),
      ];

  return (
    <div className="container mx-auto px-4 py-10 sm:px-6 lg:px-10 max-w-2xl">
      <div className="mb-8">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push(`/dashboard/${driveId}/members`)}
          className="mb-4"
        >
          <ChevronLeft className="h-4 w-4 mr-1" />
          Back to Members
        </Button>
        <h1 className="text-3xl font-bold mb-2">Drive Settings</h1>
        <p className="text-muted-foreground">Configure settings for {drive.name}</p>
      </div>

      <div className="space-y-8">
        {settingsSections.map((section) => (
          <div key={section.title}>
            <h2 className="text-sm font-medium text-muted-foreground mb-2 px-1">
              {section.title}
            </h2>
            <div className="rounded-lg border bg-card overflow-hidden">
              {section.items.map((item, index) => (
                <Link key={item.href} href={item.href}>
                  <SettingsRow item={item} index={index} />
                </Link>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
