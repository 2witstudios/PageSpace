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
  ChevronRight as ChevronRightIcon
} from "lucide-react";

interface ContactSubmission {
  id: string;
  name: string;
  email: string;
  subject: string;
  message: string;
  createdAt: string;
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
  isLoading?: boolean;
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

export function ContactSubmissionsTable({
  submissions,
  pagination,
  onSearch,
  onPageChange,
  onSort,
  isLoading = false
}: ContactSubmissionsTableProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [expandedSubmissions, setExpandedSubmissions] = useState<Record<string, boolean>>({});
  const [sortBy, setSortBy] = useState('createdAt');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

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

  if (isLoading) {
    return (
      <Card>
        <CardContent className="p-6">
          <div className="space-y-4">
            <div className="h-10 bg-muted rounded animate-pulse" />
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-16 bg-muted rounded animate-pulse" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search submissions by name, email, subject, or message..."
          value={searchTerm}
          onChange={(e) => handleSearch(e.target.value)}
          className="pl-10"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span className="flex items-center">
              <MessageSquare className="h-5 w-5 mr-2" />
              Contact Submissions
            </span>
            <Badge variant="secondary">
              {pagination.total} total submissions
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {submissions.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              {searchTerm ? 'No submissions found matching your search.' : 'No contact submissions yet.'}
            </div>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[50px]"></TableHead>
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
                              <Button variant="ghost" size="sm" className="p-1">
                                {expandedSubmissions[submission.id] ? (
                                  <ChevronDown className="h-4 w-4" />
                                ) : (
                                  <ChevronRight className="h-4 w-4" />
                                )}
                              </Button>
                            </CollapsibleTrigger>
                          </TableCell>
                          <TableCell className="font-medium">{submission.name}</TableCell>
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
                            <TableCell colSpan={6} className="bg-muted/30">
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
                                      <div>
                                        <span className="text-muted-foreground">Submitted:</span>
                                        <span className="ml-2">{formatDateTime(submission.createdAt)}</span>
                                      </div>
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
                                <div className="flex justify-end">
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
                <div className="flex items-center justify-between mt-4">
                  <div className="text-sm text-muted-foreground">
                    Showing {((pagination.page - 1) * pagination.pageSize) + 1} to {Math.min(pagination.page * pagination.pageSize, pagination.total)} of {pagination.total} submissions
                  </div>
                  <div className="flex items-center space-x-2">
                    <Button
                      variant="outline"
                      size="sm"
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
                            className="w-8 h-8 p-0"
                          >
                            {pageNum}
                          </Button>
                        );
                      })}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
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
          )}
        </CardContent>
      </Card>
    </div>
  );
}