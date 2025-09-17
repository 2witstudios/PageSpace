"use client";

import { useState, useEffect } from "react";
import { UsersTable } from "@/components/admin/UsersTable";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Users, AlertCircle, Shield, MessageCircle, Database } from "lucide-react";

interface UserData {
  id: string;
  name: string;
  email: string;
  emailVerified: string | null;
  image: string | null;
  currentAiProvider: string;
  currentAiModel: string;
  tokenVersion: number;
  subscriptionTier: 'normal' | 'pro';
  stats: {
    drives: number;
    pages: number;
    chatMessages: number;
    driveChatMessages: number;
    globalMessages: number;
    refreshTokens: number;
    aiSettings: number;
    totalMessages: number;
  };
  aiSettings: Array<{
    provider: string;
    baseUrl: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
  recentTokens: Array<{
    device: string | null;
    ip: string | null;
    userAgent: string | null;
    createdAt: string;
  }>;
}

export default function AdminUsersPage() {
  const [users, setUsers] = useState<UserData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchUsers() {
      try {
        const response = await fetch('/api/admin/users');
        if (!response.ok) {
          throw new Error('Failed to fetch users data');
        }
        const data = await response.json();
        setUsers(data.users);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'An error occurred');
      } finally {
        setLoading(false);
      }
    }

    fetchUsers();
  }, []);

  if (loading) {
    return (
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-4 w-96" />
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="text-center">
                  <Skeleton className="h-8 w-16 mx-auto mb-2" />
                  <Skeleton className="h-4 w-20 mx-auto" />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
        
        {[...Array(3)].map((_, i) => (
          <Card key={i}>
            <CardHeader>
              <div className="flex items-center space-x-4">
                <Skeleton className="h-10 w-10 rounded-full" />
                <div>
                  <Skeleton className="h-6 w-48" />
                  <Skeleton className="h-4 w-64 mt-1" />
                </div>
              </div>
            </CardHeader>
          </Card>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>
          Error loading users data: {error}
        </AlertDescription>
      </Alert>
    );
  }

  const totalStats = users.reduce(
    (acc, user) => ({
      totalDrives: acc.totalDrives + user.stats.drives,
      totalPages: acc.totalPages + user.stats.pages,
      totalMessages: acc.totalMessages + user.stats.totalMessages,
      verifiedUsers: acc.verifiedUsers + (user.emailVerified ? 1 : 0),
    }),
    { totalDrives: 0, totalPages: 0, totalMessages: 0, verifiedUsers: 0 }
  );

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center space-x-2">
            <Users className="h-5 w-5" />
            <span>User Management Overview</span>
          </CardTitle>
          <CardDescription>
            Monitor user accounts, activity statistics, and AI configurations. 
            Manage {users.length} registered users and their content.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div className="text-center">
              <div className="text-2xl font-bold text-primary">{users.length}</div>
              <div className="text-muted-foreground flex items-center justify-center">
                <Users className="h-4 w-4 mr-1" />
                Total Users
              </div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-green-600">{totalStats.verifiedUsers}</div>
              <div className="text-muted-foreground flex items-center justify-center">
                <Shield className="h-4 w-4 mr-1" />
                Verified
              </div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-primary">{totalStats.totalDrives}</div>
              <div className="text-muted-foreground flex items-center justify-center">
                <Database className="h-4 w-4 mr-1" />
                Total Drives
              </div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-primary">{totalStats.totalMessages}</div>
              <div className="text-muted-foreground flex items-center justify-center">
                <MessageCircle className="h-4 w-4 mr-1" />
                Total Messages
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <UsersTable users={users} />
    </div>
  );
}