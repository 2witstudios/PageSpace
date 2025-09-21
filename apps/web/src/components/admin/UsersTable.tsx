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
import { ChevronDown, ChevronRight, Search, Shield, MessageCircle, Database, Settings, Crown, CreditCard, CheckCircle } from "lucide-react";

interface UserStats {
  drives: number;
  pages: number;
  chatMessages: number;
  driveChatMessages: number;
  globalMessages: number;
  refreshTokens: number;
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

interface UserData {
  id: string;
  name: string;
  email: string;
  emailVerified: string | null;
  image: string | null;
  currentAiProvider: string;
  currentAiModel: string;
  tokenVersion: number;
  subscriptionTier: 'free' | 'pro' | 'business';
  stats: UserStats;
  aiSettings: AiSetting[];
  recentTokens: RefreshToken[];
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

function getUserInitials(name: string) {
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

  const filteredUsers = users.filter(user =>
    user.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    user.email.toLowerCase().includes(searchTerm.toLowerCase()) ||
    user.currentAiProvider.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const toggleUser = (userId: string) => {
    setExpandedUsers(prev => ({
      ...prev,
      [userId]: !prev[userId]
    }));
  };

  const toggleSubscription = async (userId: string, currentTier: 'free' | 'pro' | 'business') => {
    setUpdatingUsers(prev => ({ ...prev, [userId]: true }));

    try {
      // Cycle through tiers: normal -> pro -> business -> normal
      let newTier: 'free' | 'pro' | 'business';
      if (currentTier === 'free') {
        newTier = 'pro';
      } else if (currentTier === 'pro') {
        newTier = 'business';
      } else {
        newTier = 'free';
      }
      const response = await fetch(`/api/admin/users/${userId}/subscription`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ subscriptionTier: newTier }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP ${response.status}: Failed to update subscription`);
      }

      const result = await response.json();

      // Update the user in the parent component's state instead of reloading
      if (onUserUpdate) {
        onUserUpdate(userId, { subscriptionTier: newTier });
      }

      // Show success feedback
      setRecentlyUpdated(prev => ({ ...prev, [userId]: true }));
      setTimeout(() => {
        setRecentlyUpdated(prev => ({ ...prev, [userId]: false }));
      }, 3000);

      console.log('Subscription updated successfully:', result);
    } catch (error) {
      console.error('Error updating subscription:', error);

      // Show a more informative error message
      const errorMessage = error instanceof Error
        ? error.message
        : 'An unexpected error occurred';

      alert(`Failed to update subscription: ${errorMessage}`);
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
                        user.subscriptionTier === 'pro' ? "default" : "secondary"
                      }>
                        {user.subscriptionTier === 'business' ? (
                          <Crown className="h-3 w-3 mr-1" />
                        ) : user.subscriptionTier === 'pro' ? (
                          <Crown className="h-3 w-3 mr-1" />
                        ) : (
                          <CreditCard className="h-3 w-3 mr-1" />
                        )}
                        {user.subscriptionTier === 'business' ? 'Business' :
                         user.subscriptionTier === 'pro' ? 'Pro' : 'Free'}
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
                            <TableCell className="font-medium">Drive Messages</TableCell>
                            <TableCell>{user.stats.driveChatMessages}</TableCell>
                          </TableRow>
                          <TableRow>
                            <TableCell className="font-medium">Global Messages</TableCell>
                            <TableCell>{user.stats.globalMessages}</TableCell>
                          </TableRow>
                          <TableRow>
                            <TableCell className="font-medium">Active Sessions</TableCell>
                            <TableCell>{user.stats.refreshTokens}</TableCell>
                          </TableRow>
                        </TableBody>
                      </Table>
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
                          <div className="flex items-center justify-between">
                            <span className="text-sm text-muted-foreground">Current Plan:</span>
                            <Badge variant={
                              user.subscriptionTier === 'business' ? "destructive" :
                              user.subscriptionTier === 'pro' ? "default" : "secondary"
                            }>
                              {user.subscriptionTier === 'business' ? (
                                <Crown className="h-3 w-3 mr-1" />
                              ) : user.subscriptionTier === 'pro' ? (
                                <Crown className="h-3 w-3 mr-1" />
                              ) : (
                                <CreditCard className="h-3 w-3 mr-1" />
                              )}
                              {user.subscriptionTier === 'business' ? 'Business Plan' :
                               user.subscriptionTier === 'pro' ? 'Pro Plan' : 'Free Plan'}
                            </Badge>
                          </div>
                          <Button
                            size="sm"
                            variant={user.subscriptionTier === 'free' ? "default" : "destructive"}
                            onClick={() => toggleSubscription(user.id, user.subscriptionTier)}
                            disabled={updatingUsers[user.id]}
                            className="w-full"
                          >
                            {updatingUsers[user.id] ? (
                              <div className="flex items-center space-x-2">
                                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                                <span>Updating...</span>
                              </div>
                            ) : recentlyUpdated[user.id] ? (
                              <div className="flex items-center space-x-2 text-green-600">
                                <CheckCircle className="h-4 w-4" />
                                <span>Updated!</span>
                              </div>
                            ) : (
                              user.subscriptionTier === 'free' ? 'Upgrade to Pro' :
                              user.subscriptionTier === 'pro' ? 'Upgrade to Business' : 'Downgrade to Free'
                            )}
                          </Button>
                        </div>
                      </div>

                      {/* AI Settings */}
                      {user.aiSettings.length > 0 && (
                        <div>
                          <h4 className="text-sm font-medium mb-3 flex items-center">
                            <Settings className="h-4 w-4 mr-2" />
                            AI Configurations ({user.aiSettings.length})
                          </h4>
                          <div className="space-y-2">
                            {user.aiSettings.map((setting, index) => (
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
                      {user.recentTokens.length > 0 && (
                        <div>
                          <h4 className="text-sm font-medium mb-3">Recent Sessions</h4>
                          <div className="space-y-2">
                            {user.recentTokens.map((token, index) => (
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