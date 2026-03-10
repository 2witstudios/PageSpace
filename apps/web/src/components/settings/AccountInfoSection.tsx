"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Calendar, Mail } from "lucide-react";

interface AccountInfoSectionProps {
  userId: string;
  memberSince: string;
}

export function AccountInfoSection({ userId, memberSince }: AccountInfoSectionProps) {
  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle>Account Information</CardTitle>
        <CardDescription>View your account details</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2 text-sm">
          <Calendar className="h-4 w-4 text-muted-foreground" />
          <span className="text-muted-foreground">Member since:</span>
          <span>{memberSince}</span>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Mail className="h-4 w-4 text-muted-foreground" />
          <span className="text-muted-foreground">Account ID:</span>
          <span className="font-mono text-xs">{userId}</span>
        </div>
      </CardContent>
    </Card>
  );
}
