"use client";

import { useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  ChevronDown,
  ChevronRight,
  Search,
  Mail,
  MessageSquare,
  User,
  Calendar,
  ExternalLink,
  ChevronLeft,
  ChevronRight as ChevronRightIcon,
  CheckCircle2,
  Circle,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { DataState } from "@/components/admin/kit";
import { fetchWithAuth } from "@/lib/auth/auth-fetch";

interface RegisteredUser {
  id: string;
  subscriptionTier: string | null;
}

interface ContactSubmission {
  id: string;
  name: string;
  email: string;
  subject: string;
  message: string;
  createdAt: string;
  resolvedAt: string | null;
  registeredUser: RegisteredUser | null;
}

interface ContactSubmissionsTableProps {
  submissions: ContactSubmission[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPrevPage: boolean;
  };
  onSearch: (searchTerm: string) => void;
  onPageChange: (page: number) => void;
  onSort: (sortBy: string, sortOrder: 'asc' | 'desc') => void;
  onStatusFilter: (status: 'all' | 'open' | 'closed') => void;
  statusFilter: 'all' | 'open' | 'closed';
  isLoading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  /** True when a stale response is still renderable behind an error. */
  hasData?: boolean;
}

function formatDate(dateString: string) {
  return new Date(dateString).toLocaleDateString();
}

function formatDateTime(dateString: string) {
  return new Date(dateString).toLocaleString();
}

function truncateText(text: string, maxLength: number = 100) {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength) + '...';
}

function tierColor(tier: string | null): string {
  switch (tier) {
    case 'pro': return 'bg-info/15 text-info';
    case 'founder': return 'bg-primary/15 text-primary';
    case 'business': return 'bg-success/15 text-success';
    default: return 'bg-muted text-muted-foreground';
  }
}

export function ContactSubmissionsTable({
  submissions,
  pagination,
  onSearch,
  onPageChange,
  onSort,
  onStatusFilter,
  statusFilter,
  isLoading = false,
  error = null,
  onRetry,
  hasData,
}: ContactSubmissionsTableProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [expandedSubmissions, setExpandedSubmissions] = useState<Record<string, boolean>>({});
  const [sortBy, setSortBy] = useState('createdAt');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [localResolved, setLocalResolved] = useState<Record<string, boolean>>({});
  const [resolveError, setResolveError] = useState<string | null>(null);

  const handleSearch = (value: string) => {
    setSearchTerm(value);
    onSearch(value);
  };

  const handleSort = (column: string) => {
    const newSortOrder = sortBy === column && sortOrder === 'desc' ? 'asc' : 'desc';
    setSortBy(column);
    setSortOrder(newSortOrder);
    onSort(column, newSortOrder);
  };

  const toggleSubmission = (submissionId: string) => {
    setExpandedSubmissions(prev => ({
      ...prev,
      [submissionId]: !prev[submissionId]
    }));
  };

  const getSortIcon = (column: string) => {
    if (sortBy !== column) return null;
    return sortOrder === 'asc' ? '↑' : '↓';
  };

  const handleToggleResolved = async (submission: ContactSubmission) => {
    const isResolved = localResolved[submission.id] !== undefined
      ? localResolved[submission.id]
      : submission.resolvedAt !== null;
    setResolvingId(submission.id);
    setResolveError(null);
    try {
      const response = await fetchWithAuth(`/api/admin/contact/${submission.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolved: !isResolved }),
      });
      if (response.ok) {
        setLocalResolved(prev => ({ ...prev, [submission.id]: !isResolved }));
      } else {
        setResolveError(`Failed to update submission (${response.status})`);
      }
    } catch {
      setResolveError('Network error — please try again');
    } finally {
      setResolvingId(null);
    }
  };

  const isResolved = (submission: ContactSubmission) =>
    localResolved[submission.id] !== undefined
      ? localResolved[submission.id]
      : submission.resolvedAt !== null;

  return (
    <div className="space-y-4">
      {resolveError && (
        <div className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded">
          {resolveError}
        </div>
      )}
      <div className="flex gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by name, email, subject, or message…"
            value={searchTerm}
            onChange={(e) => handleSearch(e.target.value)}
            className="h-10 pl-10"
          />
        </div>
        <div className="flex gap-1">
          {(['all', 'open', 'closed'] as const).map((s) => (
            <Button
              key={s}
              variant={statusFilter === s ? 'default' : 'outline'}
              size="sm"
              onClick={() => onStatusFilter(s)}
              className="h-10 capitalize"
            >
              {s}
            </Button>
          ))}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span className="flex items-center">
              <MessageSquare className="h-5 w-5 mr-2" />
              Contact Submissions
            </span>
            <Badge variant="secondary">
              {pagination.total} {statusFilter !== 'all' ? statusFilter : 'total'} submissions
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <DataState
            isLoading={isLoading}
            error={error}
            isEmpty={submissions.length === 0}
            emptyMessage={
              searchTerm
                ? 'No submissions found matching your search.'
                : 'When users submit the contact form on your website, their messages will appear here.'
            }
            onRetry={onRetry}
            hasData={hasData}
            skeleton={
              <div className="space-y-3">
                {[...Array(6)].map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            }
          >
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[50px]"></TableHead>
                    <TableHead className="w-[90px]">Status</TableHead>
                    <TableHead
                      className="cursor-pointer hover:bg-muted/50"
                      onClick={() => handleSort('name')}
                    >
                      <div className="flex items-center">
                        <User className="h-4 w-4 mr-2" />
                        Name {getSortIcon('name')}
                      </div>
                    </TableHead>
                    <TableHead
                      className="cursor-pointer hover:bg-muted/50"
                      onClick={() => handleSort('email')}
                    >
                      <div className="flex items-center">
                        <Mail className="h-4 w-4 mr-2" />
                        Email {getSortIcon('email')}
                      </div>
                    </TableHead>
                    <TableHead
                      className="cursor-pointer hover:bg-muted/50"
                      onClick={() => handleSort('subject')}
                    >
                      Subject {getSortIcon('subject')}
                    </TableHead>
                    <TableHead className="max-w-[300px]">Message Preview</TableHead>
                    <TableHead
                      className="cursor-pointer hover:bg-muted/50"
                      onClick={() => handleSort('createdAt')}
                    >
                      <div className="flex items-center">
                        <Calendar className="h-4 w-4 mr-2" />
                        Date {getSortIcon('createdAt')}
                      </div>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {submissions.map((submission) => (
                    <Collapsible
                      key={submission.id}
                      open={expandedSubmissions[submission.id]}
                      onOpenChange={() => toggleSubmission(submission.id)}
                      asChild
                    >
                      <>
                        <TableRow className="group">
                          <TableCell>
                            <CollapsibleTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-10 w-10">
                                {expandedSubmissions[submission.id] ? (
                                  <ChevronDown className="h-4 w-4" />
                                ) : (
                                  <ChevronRight className="h-4 w-4" />
                                )}
                              </Button>
                            </CollapsibleTrigger>
                          </TableCell>
                          <TableCell>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-10 w-10"
                              onClick={(e) => { e.stopPropagation(); handleToggleResolved(submission); }}
                              disabled={resolvingId === submission.id}
                              title={isResolved(submission) ? 'Mark open' : 'Mark resolved'}
                            >
                              {isResolved(submission)
                                ? <CheckCircle2 className="h-4 w-4 text-success" />
                                : <Circle className="h-4 w-4 text-muted-foreground" />
                              }
                            </Button>
                          </TableCell>
                          <TableCell className="font-medium">
                            <div className="flex items-center gap-1.5">
                              {submission.name}
                              {submission.registeredUser && (
                                <Badge className={`text-[10px] px-1 py-0 ${tierColor(submission.registeredUser.subscriptionTier)}`}>
                                  {submission.registeredUser.subscriptionTier ?? 'free'}
                                </Badge>
                              )}
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center">
                              <span className="mr-2">{submission.email}</span>
                              <Button variant="ghost" size="sm" asChild className="p-1 opacity-0 group-hover:opacity-100">
                                <a href={`mailto:${submission.email}`}>
                                  <ExternalLink className="h-3 w-3" />
                                </a>
                              </Button>
                            </div>
                          </TableCell>
                          <TableCell className="max-w-[200px]">
                            <div title={submission.subject}>
                              {truncateText(submission.subject, 50)}
                            </div>
                          </TableCell>
                          <TableCell className="max-w-[300px]">
                            <div className="text-muted-foreground text-sm" title={submission.message}>
                              {truncateText(submission.message, 80)}
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="text-sm">
                              <div>{formatDate(submission.createdAt)}</div>
                              <div className="text-muted-foreground text-xs">
                                {new Date(submission.createdAt).toLocaleTimeString()}
                              </div>
                            </div>
                          </TableCell>
                        </TableRow>
                        <CollapsibleContent asChild>
                          <TableRow>
                            <TableCell colSpan={7} className="bg-muted/30">
                              <div className="p-4 space-y-4">
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                  <div>
                                    <h4 className="font-medium mb-2 flex items-center">
                                      <User className="h-4 w-4 mr-2" />
                                      Contact Information
                                    </h4>
                                    <div className="space-y-2 text-sm">
                                      <div>
                                        <span className="text-muted-foreground">Name:</span>
                                        <span className="ml-2 font-medium">{submission.name}</span>
                                      </div>
                                      <div>
                                        <span className="text-muted-foreground">Email:</span>
                                        <span className="ml-2">
                                          <a
                                            href={`mailto:${submission.email}`}
                                            className="text-primary hover:underline"
                                          >
                                            {submission.email}
                                          </a>
                                        </span>
                                      </div>
                                      {submission.registeredUser ? (
                                        <div>
                                          <span className="text-muted-foreground">Account:</span>
                                          <span className="ml-2 flex items-center gap-1.5 inline-flex">
                                            <Badge className={`text-xs ${tierColor(submission.registeredUser.subscriptionTier)}`}>
                                              {submission.registeredUser.subscriptionTier ?? 'free'} user
                                            </Badge>
                                            <span className="text-muted-foreground text-xs font-mono">{submission.registeredUser.id}</span>
                                          </span>
                                        </div>
                                      ) : (
                                        <div>
                                          <span className="text-muted-foreground">Account:</span>
                                          <span className="ml-2 text-muted-foreground text-xs">Not registered</span>
                                        </div>
                                      )}
                                      <div>
                                        <span className="text-muted-foreground">Submitted:</span>
                                        <span className="ml-2">{formatDateTime(submission.createdAt)}</span>
                                      </div>
                                      {isResolved(submission) && (
                                        <div>
                                          <span className="text-muted-foreground">Resolved:</span>
                                          <span className="ml-2 text-success">Yes</span>
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                  <div>
                                    <h4 className="font-medium mb-2 flex items-center">
                                      <MessageSquare className="h-4 w-4 mr-2" />
                                      Subject
                                    </h4>
                                    <p className="text-sm bg-background p-3 rounded border">
                                      {submission.subject}
                                    </p>
                                  </div>
                                </div>
                                <div>
                                  <h4 className="font-medium mb-2">Full Message</h4>
                                  <div className="bg-background p-4 rounded border text-sm whitespace-pre-wrap">
                                    {submission.message}
                                  </div>
                                </div>
                                <div className="flex justify-between items-center">
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => handleToggleResolved(submission)}
                                    disabled={resolvingId === submission.id}
                                    className="gap-2"
                                  >
                                    {isResolved(submission)
                                      ? <><Circle className="h-4 w-4" />Mark open</>
                                      : <><CheckCircle2 className="h-4 w-4 text-success" />Mark resolved</>
                                    }
                                  </Button>
                                  <Button asChild size="sm">
                                    <a href={`mailto:${submission.email}?subject=Re: ${submission.subject}`}>
                                      <Mail className="h-4 w-4 mr-2" />
                                      Reply via Email
                                    </a>
                                  </Button>
                                </div>
                              </div>
                            </TableCell>
                          </TableRow>
                        </CollapsibleContent>
                      </>
                    </Collapsible>
                  ))}
                </TableBody>
              </Table>

              {/* Pagination */}
              {pagination.totalPages > 1 && (
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                  <div className="text-sm text-muted-foreground">
                    Showing {((pagination.page - 1) * pagination.pageSize) + 1} to {Math.min(pagination.page * pagination.pageSize, pagination.total)} of {pagination.total} submissions
                  </div>
                  <div className="flex items-center space-x-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-10"
                      onClick={() => onPageChange(pagination.page - 1)}
                      disabled={!pagination.hasPrevPage}
                    >
                      <ChevronLeft className="h-4 w-4 mr-1" />
                      Previous
                    </Button>
                    <div className="flex items-center space-x-1">
                      {Array.from({ length: Math.min(5, pagination.totalPages) }, (_, i) => {
                        const pageNum = Math.max(1, pagination.page - 2) + i;
                        if (pageNum > pagination.totalPages) return null;
                        return (
                          <Button
                            key={pageNum}
                            variant={pageNum === pagination.page ? "default" : "outline"}
                            size="sm"
                            onClick={() => onPageChange(pageNum)}
                            className="h-10 w-10 p-0"
                          >
                            {pageNum}
                          </Button>
                        );
                      })}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-10"
                      onClick={() => onPageChange(pagination.page + 1)}
                      disabled={!pagination.hasNextPage}
                    >
                      Next
                      <ChevronRightIcon className="h-4 w-4 ml-1" />
                    </Button>
                  </div>
                </div>
              )}
            </>
          </DataState>
        </CardContent>
      </Card>
    </div>
  );
}
