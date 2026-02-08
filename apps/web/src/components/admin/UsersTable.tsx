"use client";

import { useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { ChevronDown, ChevronRight, Search, Shield, MessageCircle, Database, Settings, Crown, CreditCard, CheckCircle, Gift, ExternalLink, XCircle } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { post, del } from "@/lib/auth/auth-fetch";

interface UserStats {
  drives: number;
  pages: number;
  chatMessages: number;
  globalMessages: number;
  aiSettings: number;
  totalMessages: number;
}

interface AiSetting {
  provider: string;
  baseUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RefreshToken {
  device: string | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
}

interface SubscriptionData {
  id: string;
  stripeSubscriptionId: string;
  status: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  isGifted: boolean;
  giftedBy?: string;
  giftReason?: string;
}

interface UserData {
  id: string;
  name: string;
  email: string;
  emailVerified: string | null;
  image: string | null;
  currentAiProvider: string;
  currentAiModel: string;
  tokenVersion: number;
  subscriptionTier: 'free' | 'pro' | 'founder' | 'business';
  stripeCustomerId: string | null;
  stats: UserStats;
  aiSettings: AiSetting[];
  recentTokens: RefreshToken[];
  subscription: SubscriptionData | null;
}

interface UsersTableProps {
  users: UserData[];
  onUserUpdate?: (userId: string, updatedUser: Partial<UserData>) => void;
}

function formatDate(dateString: string | null) {
  if (!dateString) return "Never";
  return new Date(dateString).toLocaleDateString();
}

function formatDateTime(dateString: string | null) {
  if (!dateString) return "Never";
  return new Date(dateString).toLocaleString();
}

function getUserInitials(name: string | null | undefined) {
  if (!name) return "U";

  return name
    .split(" ")
    .map(part => part.charAt(0))
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

export function UsersTable({ users, onUserUpdate }: UsersTableProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [expandedUsers, setExpandedUsers] = useState<Record<string, boolean>>({});
  const [updatingUsers, setUpdatingUsers] = useState<Record<string, boolean>>({});
  const [recentlyUpdated, setRecentlyUpdated] = useState<Record<string, boolean>>({});
  const [selectedTiers, setSelectedTiers] = useState<Record<string, string>>({});

  const filteredUsers = users.filter((user) => {
    const normalizedSearchTerm = searchTerm.toLowerCase();
    const name = (user.name ?? "").toLowerCase();
    const email = (user.email ?? "").toLowerCase();
    const currentAiProvider = (user.currentAiProvider ?? "").toLowerCase();

    return (
      name.includes(normalizedSearchTerm) ||
      email.includes(normalizedSearchTerm) ||
      currentAiProvider.includes(normalizedSearchTerm)
    );
  });

  const toggleUser = (userId: string) => {
    setExpandedUsers(prev => ({
      ...prev,
      [userId]: !prev[userId]
    }));
  };

  const giftSubscription = async (userId: string, tier: string) => {
    if (!tier || tier === 'free') {
      alert('Please select a tier to gift');
      return;
    }

    setUpdatingUsers(prev => ({ ...prev, [userId]: true }));

    try {
      const result = await post(`/api/admin/users/${userId}/gift-subscription`, {
        tier,
        reason: 'Admin gift'
      });

      // Show success feedback
      setRecentlyUpdated(prev => ({ ...prev, [userId]: true }));
      setTimeout(() => {
        setRecentlyUpdated(prev => ({ ...prev, [userId]: false }));
      }, 3000);

      // Reset tier selection
      setSelectedTiers(prev => ({ ...prev, [userId]: '' }));

      // Trigger refresh of user data
      if (onUserUpdate) {
        onUserUpdate(userId, { subscriptionTier: tier as UserData['subscriptionTier'] });
      }

      console.log('Gift subscription created:', result);
    } catch (error) {
      console.error('Error gifting subscription:', error);
      const errorMessage = error instanceof Error ? error.message : 'An unexpected error occurred';
      alert(`Failed to gift subscription: ${errorMessage}`);
    } finally {
      setUpdatingUsers(prev => ({ ...prev, [userId]: false }));
    }
  };

  const revokeGiftSubscription = async (userId: string) => {
    if (!confirm('Are you sure you want to revoke this gift subscription? The user will be downgraded to free tier.')) {
      return;
    }

    setUpdatingUsers(prev => ({ ...prev, [userId]: true }));

    try {
      const result = await del(`/api/admin/users/${userId}/gift-subscription`);

      // Show success feedback
      setRecentlyUpdated(prev => ({ ...prev, [userId]: true }));
      setTimeout(() => {
        setRecentlyUpdated(prev => ({ ...prev, [userId]: false }));
      }, 3000);

      // Trigger refresh of user data
      if (onUserUpdate) {
        onUserUpdate(userId, { subscriptionTier: 'free', subscription: null });
      }

      console.log('Gift subscription revoked:', result);
    } catch (error) {
      console.error('Error revoking subscription:', error);
      const errorMessage = error instanceof Error ? error.message : 'An unexpected error occurred';
      alert(`Failed to revoke subscription: ${errorMessage}`);
    } finally {
      setUpdatingUsers(prev => ({ ...prev, [userId]: false }));
    }
  };

  return (
    <div className="space-y-4">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search users by name, email, or AI provider..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="pl-10"
        />
      </div>

      <div className="grid gap-4">
        {filteredUsers.map((user) => (
          <Card key={user.id}>
            <Collapsible
              open={expandedUsers[user.id]}
              onOpenChange={() => toggleUser(user.id)}
            >
              <CollapsibleTrigger asChild>
                <CardHeader className="cursor-pointer hover:bg-muted/50 transition-colors">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-4">
                      {expandedUsers[user.id] ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronRight className="h-4 w-4" />
                      )}

                      <Avatar className="h-10 w-10">
                        <AvatarImage src={user.image || undefined} />
                        <AvatarFallback>{getUserInitials(user.name)}</AvatarFallback>
                      </Avatar>

                      <div>
                        <CardTitle className="text-lg">{user.name}</CardTitle>
                        <p className="text-sm text-muted-foreground">{user.email}</p>
                      </div>
                    </div>

                    <div className="flex items-center space-x-2">
                      <Badge variant={user.emailVerified ? "default" : "secondary"}>
                        <Shield className="h-3 w-3 mr-1" />
                        {user.emailVerified ? "Verified" : "Unverified"}
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
                        user.subscriptionTier === 'business' ? "destructive" :
                          user.subscriptionTier === 'founder' ? "default" :
                            user.subscriptionTier === 'pro' ? "default" : "secondary"
                      }>
                        {user.subscription?.isGifted ? (
                          <Gift className="h-3 w-3 mr-1" />
                        ) : user.subscriptionTier !== 'free' ? (
                          <Crown className="h-3 w-3 mr-1" />
                        ) : (
                          <CreditCard className="h-3 w-3 mr-1" />
                        )}
                        {user.subscriptionTier === 'business' ? 'Business' :
                          user.subscriptionTier === 'founder' ? 'Founder' :
                            user.subscriptionTier === 'pro' ? 'Pro' : 'Free'}
                        {user.subscription?.isGifted && ' 🎁'}
                      </Badge>
                    </div>
                  </div>
                </CardHeader>
              </CollapsibleTrigger>

              <CollapsibleContent>
                <CardContent>
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    {/* User Stats */}
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

                    {/* AI Settings and Account Info */}
                    <div className="space-y-4">
                      {/* Account Details */}
                      <div>
                        <h4 className="text-sm font-medium mb-3 flex items-center">
                          <Shield className="h-4 w-4 mr-2" />
                          Account Details
                        </h4>
                        <div className="space-y-2 text-sm">
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">User ID:</span>
                            <span className="font-mono text-xs">{user.id}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Email Verified:</span>
                            <span>{formatDate(user.emailVerified)}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Token Version:</span>
                            <span>{user.tokenVersion}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Current AI Provider:</span>
                            <Badge variant="secondary">{user.currentAiProvider}</Badge>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Current AI Model:</span>
                            <span className="text-xs">{user.currentAiModel}</span>
                          </div>
                        </div>
                      </div>

                      {/* Subscription Management */}
                      <div>
                        <h4 className="text-sm font-medium mb-3 flex items-center">
                          <CreditCard className="h-4 w-4 mr-2" />
                          Subscription Management
                        </h4>
                        <div className="space-y-3">
                          {/* Current Plan Badge */}
                          <div className="flex items-center justify-between">
                            <span className="text-sm text-muted-foreground">Current Plan:</span>
                            <Badge variant={
                              user.subscriptionTier === 'business' ? "destructive" :
                                user.subscriptionTier === 'founder' ? "default" :
                                  user.subscriptionTier === 'pro' ? "default" : "secondary"
                            }>
                              {user.subscription?.isGifted && <Gift className="h-3 w-3 mr-1" />}
                              {!user.subscription?.isGifted && user.subscriptionTier !== 'free' && <Crown className="h-3 w-3 mr-1" />}
                              {user.subscriptionTier === 'free' && <CreditCard className="h-3 w-3 mr-1" />}
                              {user.subscriptionTier === 'business' ? 'Business' :
                                user.subscriptionTier === 'founder' ? 'Founder' :
                                  user.subscriptionTier === 'pro' ? 'Pro' : 'Free'}
                              {user.subscription?.isGifted && ' (Gifted)'}
                            </Badge>
                          </div>

                          {/* Subscription Status */}
                          {user.subscription && (
                            <div className="flex items-center justify-between">
                              <span className="text-sm text-muted-foreground">Status:</span>
                              <Badge variant={user.subscription.status === 'active' ? 'default' : 'secondary'}>
                                {user.subscription.status}
                              </Badge>
                            </div>
                          )}

                          {/* Gifted Subscription Warning */}
                          {user.subscription?.isGifted && (
                            <div className="p-2 bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 rounded text-xs">
                              <div className="flex items-center gap-1 text-amber-800 dark:text-amber-200">
                                <Gift className="h-3 w-3" />
                                <span>Gifted subscription</span>
                              </div>
                              {user.subscription.giftReason && (
                                <div className="mt-1 text-muted-foreground">
                                  Reason: {user.subscription.giftReason}
                                </div>
                              )}
                            </div>
                          )}

                          {/* Actions based on subscription state */}
                          {!user.subscription ? (
                            // No subscription - show gift controls
                            <div className="space-y-2">
                              <Select
                                value={selectedTiers[user.id] || ''}
                                onValueChange={(value) => setSelectedTiers(prev => ({ ...prev, [user.id]: value }))}
                                disabled={updatingUsers[user.id]}
                              >
                                <SelectTrigger className="w-full">
                                  <SelectValue placeholder="Select tier to gift..." />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="pro">Pro ($15/mo value)</SelectItem>
                                  <SelectItem value="founder">Founder ($50/mo value)</SelectItem>
                                  <SelectItem value="business">Business ($100/mo value)</SelectItem>
                                </SelectContent>
                              </Select>
                              <Button
                                size="sm"
                                variant="default"
                                onClick={() => giftSubscription(user.id, selectedTiers[user.id] || '')}
                                disabled={updatingUsers[user.id] || !selectedTiers[user.id]}
                                className="w-full"
                              >
                                {updatingUsers[user.id] ? (
                                  <div className="flex items-center space-x-2">
                                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                                    <span>Gifting...</span>
                                  </div>
                                ) : recentlyUpdated[user.id] ? (
                                  <div className="flex items-center space-x-2 text-green-600">
                                    <CheckCircle className="h-4 w-4" />
                                    <span>Gifted!</span>
                                  </div>
                                ) : (
                                  <>
                                    <Gift className="h-4 w-4 mr-2" />
                                    Gift Subscription
                                  </>
                                )}
                              </Button>
                            </div>
                          ) : user.subscription.isGifted ? (
                            // Gifted subscription - show revoke button
                            <Button
                              size="sm"
                              variant="destructive"
                              onClick={() => revokeGiftSubscription(user.id)}
                              disabled={updatingUsers[user.id]}
                              className="w-full"
                            >
                              {updatingUsers[user.id] ? (
                                <div className="flex items-center space-x-2">
                                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                                  <span>Revoking...</span>
                                </div>
                              ) : recentlyUpdated[user.id] ? (
                                <div className="flex items-center space-x-2">
                                  <CheckCircle className="h-4 w-4" />
                                  <span>Revoked!</span>
                                </div>
                              ) : (
                                <>
                                  <XCircle className="h-4 w-4 mr-2" />
                                  Revoke Gift
                                </>
                              )}
                            </Button>
                          ) : (
                            // Paid subscription - show link to Stripe
                            <div className="space-y-2">
                              <div className="p-2 bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800 rounded text-xs">
                                <div className="flex items-center gap-1 text-blue-800 dark:text-blue-200">
                                  <CreditCard className="h-3 w-3" />
                                  <span>Paid subscription - manage in Stripe</span>
                                </div>
                              </div>
                              {user.stripeCustomerId && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="w-full"
                                  onClick={() => window.open(`https://dashboard.stripe.com/test/customers/${user.stripeCustomerId}`, '_blank')}
                                >
                                  <ExternalLink className="h-4 w-4 mr-2" />
                                  Open in Stripe
                                </Button>
                              )}
                            </div>
                          )}
                        </div>
                      </div>

                      {/* AI Settings */}
                      {(user.aiSettings?.length ?? 0) > 0 && (
                        <div>
                          <h4 className="text-sm font-medium mb-3 flex items-center">
                            <Settings className="h-4 w-4 mr-2" />
                            AI Configurations ({user.aiSettings?.length ?? 0})
                          </h4>
                          <div className="space-y-2">
                            {(user.aiSettings ?? []).map((setting, index) => (
                              <div key={index} className="p-2 border rounded text-xs">
                                <div className="flex justify-between items-center">
                                  <Badge variant="outline">{setting.provider}</Badge>
                                  <span className="text-muted-foreground">
                                    Updated {formatDate(setting.updatedAt)}
                                  </span>
                                </div>
                                {setting.baseUrl && (
                                  <div className="mt-1 text-muted-foreground">
                                    Base URL: {setting.baseUrl}
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Recent Sessions */}
                      {(user.recentTokens?.length ?? 0) > 0 && (
                        <div>
                          <h4 className="text-sm font-medium mb-3">Recent Sessions</h4>
                          <div className="space-y-2">
                            {(user.recentTokens ?? []).map((token, index) => (
                              <div key={index} className="p-2 border rounded text-xs">
                                <div className="flex justify-between">
                                  <span>{token.device || "Unknown Device"}</span>
                                  <span className="text-muted-foreground">
                                    {formatDateTime(token.createdAt)}
                                  </span>
                                </div>
                                {token.ip && (
                                  <div className="text-muted-foreground">IP: {token.ip}</div>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </CardContent>
              </CollapsibleContent>
            </Collapsible>
          </Card>
        ))}
      </div>
    </div>
  );
}
