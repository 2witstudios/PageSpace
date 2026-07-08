'use client';

import { useState } from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  Ban,
  ChevronDown,
  ChevronRight,
  Clock,
  CreditCard,
  Crown,
  Database,
  Gift,
  MessageCircle,
  Shield,
} from 'lucide-react';
import { SubscriptionControls } from './subscription-controls';
import { AdminControls } from './admin-controls';
import {
  formatDate,
  formatDateTime,
  formatLastActive,
  getUserInitials,
  tierLabel,
} from './user-format';
import { isDormant } from '@/lib/dormancy';
import type { AdminUser } from './types';

interface UserRowProps {
  user: AdminUser;
  onActionComplete: () => void;
}

export function UserRow({ user, onActionComplete }: UserRowProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <Card>
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <CollapsibleTrigger asChild>
          <CardHeader className="cursor-pointer hover:bg-muted/50 transition-colors">
            <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
              <div className="flex min-w-0 items-center gap-4">
                {expanded ? (
                  <ChevronDown className="h-4 w-4 shrink-0" />
                ) : (
                  <ChevronRight className="h-4 w-4 shrink-0" />
                )}

                <Avatar className="h-10 w-10 shrink-0">
                  <AvatarImage src={user.image || undefined} />
                  <AvatarFallback>{getUserInitials(user.name)}</AvatarFallback>
                </Avatar>

                <div className="min-w-0">
                  <CardTitle className="truncate text-lg">{user.name}</CardTitle>
                  <p className="truncate text-sm text-muted-foreground">{user.email}</p>
                </div>
              </div>

              {/* flex-wrap so the badges reflow instead of crushing on mobile */}
              <div className="flex flex-wrap items-center gap-2">
                {user.suspendedAt && (
                  <Badge variant="destructive">
                    <Ban className="h-3 w-3 mr-1" />
                    Suspended
                  </Badge>
                )}

                {user.role === 'admin' && (
                  <Badge>
                    <Shield className="h-3 w-3 mr-1" />
                    Admin
                  </Badge>
                )}

                <Badge variant={user.emailVerified ? 'default' : 'secondary'}>
                  <Shield className="h-3 w-3 mr-1" />
                  {user.emailVerified ? 'Verified' : 'Unverified'}
                </Badge>

                <Badge variant={isDormant(user.lastActiveAt) ? 'secondary' : 'outline'}>
                  <Clock className="h-3 w-3 mr-1" />
                  {formatLastActive(user.lastActiveAt)}
                </Badge>

                <Badge variant="outline">
                  <Database className="h-3 w-3 mr-1" />
                  {user.stats.drives} drives
                </Badge>

                <Badge variant="outline">
                  <MessageCircle className="h-3 w-3 mr-1" />
                  {user.stats.totalMessages} messages
                </Badge>

                <Badge variant={
                  user.subscriptionTier === 'business' ? 'destructive' :
                    user.subscriptionTier === 'founder' || user.subscriptionTier === 'pro' ? 'default' : 'secondary'
                }>
                  {user.subscription?.isGifted ? (
                    <Gift className="h-3 w-3 mr-1" />
                  ) : user.subscriptionTier !== 'free' ? (
                    <Crown className="h-3 w-3 mr-1" />
                  ) : (
                    <CreditCard className="h-3 w-3 mr-1" />
                  )}
                  {tierLabel(user.subscriptionTier)}
                </Badge>
              </div>
            </div>
          </CardHeader>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <CardContent>
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <div className="space-y-4">
                <div>
                  <h4 className="text-sm font-medium mb-3 flex items-center">
                    <Database className="h-4 w-4 mr-2" />
                    Content Statistics
                  </h4>
                  <div className="overflow-x-auto">
                    <Table>
                      <TableBody>
                        <TableRow>
                          <TableCell className="font-medium">Drives</TableCell>
                          <TableCell>{user.stats.drives}</TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell className="font-medium">Pages</TableCell>
                          <TableCell>{user.stats.pages}</TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell className="font-medium">Page Messages</TableCell>
                          <TableCell>{user.stats.chatMessages}</TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell className="font-medium">Global Messages</TableCell>
                          <TableCell>{user.stats.globalMessages}</TableCell>
                        </TableRow>
                      </TableBody>
                    </Table>
                  </div>
                </div>

                <div>
                  <h4 className="text-sm font-medium mb-3 flex items-center">
                    <Shield className="h-4 w-4 mr-2" />
                    Account Details
                  </h4>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">User ID:</span>
                      <span className="font-mono text-xs">{user.id}</span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">Role:</span>
                      <Badge variant={user.role === 'admin' ? 'default' : 'secondary'}>{user.role}</Badge>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">Created:</span>
                      <span>{formatDate(user.createdAt)}</span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">Last Active:</span>
                      <span>{user.lastActiveAt ? formatDateTime(user.lastActiveAt) : 'Never'}</span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">Email Verified:</span>
                      <span>{formatDate(user.emailVerified)}</span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">Token Version:</span>
                      <span>{user.tokenVersion}</span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">Current AI Provider:</span>
                      <Badge variant="secondary">{user.currentAiProvider}</Badge>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">Current AI Model:</span>
                      <span className="text-xs">{user.currentAiModel}</span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="space-y-6">
                <SubscriptionControls user={user} onActionComplete={onActionComplete} />
                <AdminControls user={user} onActionComplete={onActionComplete} />
              </div>
            </div>
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
