"use client";

import { useState, useEffect, useCallback } from "react";
import { ContactSubmissionsTable } from "@/components/admin/ContactSubmissionsTable";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { MessageSquare, AlertCircle, Mail, Calendar, TrendingUp, Users } from "lucide-react";

interface ContactSubmission {
  id: string;
  name: string;
  email: string;
  subject: string;
  message: string;
  createdAt: string;
}

interface PaginationData {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

interface ApiResponse {
  submissions: ContactSubmission[];
  pagination: PaginationData;
  meta: {
    searchTerm: string;
    sortBy: string;
    sortOrder: string;
  };
}

export default function AdminSupportPage() {
  const [submissions, setSubmissions] = useState<ContactSubmission[]>([]);
  const [pagination, setPagination] = useState<PaginationData>({
    page: 1,
    pageSize: 25,
    total: 0,
    totalPages: 0,
    hasNextPage: false,
    hasPrevPage: false
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [sortBy, setSortBy] = useState("createdAt");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");

  const fetchSubmissions = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({
        search: searchTerm,
        sortBy,
        sortOrder,
        page: pagination.page.toString(),
        pageSize: pagination.pageSize.toString()
      });

      const response = await fetch(`/api/admin/contact?${params}`);

      if (!response.ok) {
        throw new Error('Failed to fetch contact submissions');
      }

      const data: ApiResponse = await response.json();
      setSubmissions(data.submissions);
      setPagination(data.pagination);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [searchTerm, sortBy, sortOrder, pagination.page, pagination.pageSize]);

  useEffect(() => {
    fetchSubmissions();
  }, [fetchSubmissions]);

  const handleSearch = (newSearchTerm: string) => {
    setSearchTerm(newSearchTerm);
    setPagination(prev => ({ ...prev, page: 1 })); // Reset to first page on search
  };

  const handlePageChange = (newPage: number) => {
    setPagination(prev => ({ ...prev, page: newPage }));
  };

  const handleSort = (newSortBy: string, newSortOrder: "asc" | "desc") => {
    setSortBy(newSortBy);
    setSortOrder(newSortOrder);
    setPagination(prev => ({ ...prev, page: 1 })); // Reset to first page on sort
  };

  // Calculate statistics
  const todaySubmissions = submissions.filter(submission => {
    const today = new Date();
    const submissionDate = new Date(submission.createdAt);
    return submissionDate.toDateString() === today.toDateString();
  }).length;

  const weekSubmissions = submissions.filter(submission => {
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    const submissionDate = new Date(submission.createdAt);
    return submissionDate >= weekAgo;
  }).length;

  const uniqueEmails = new Set(submissions.map(s => s.email)).size;

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>
          Error loading contact submissions: {error}
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center space-x-2">
            <MessageSquare className="h-5 w-5" />
            <span>Support Dashboard</span>
          </CardTitle>
          <CardDescription>
            Monitor and respond to contact form submissions from your website.
            {pagination.total > 0 && ` Showing ${pagination.total} total submissions.`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div className="text-center">
              <div className="text-2xl font-bold text-primary">{pagination.total}</div>
              <div className="text-muted-foreground flex items-center justify-center">
                <MessageSquare className="h-4 w-4 mr-1" />
                Total Submissions
              </div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-blue-600">{todaySubmissions}</div>
              <div className="text-muted-foreground flex items-center justify-center">
                <Calendar className="h-4 w-4 mr-1" />
                Today
              </div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-green-600">{weekSubmissions}</div>
              <div className="text-muted-foreground flex items-center justify-center">
                <TrendingUp className="h-4 w-4 mr-1" />
                This Week
              </div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-purple-600">{uniqueEmails}</div>
              <div className="text-muted-foreground flex items-center justify-center">
                <Users className="h-4 w-4 mr-1" />
                Unique Contacts
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <ContactSubmissionsTable
        submissions={submissions}
        pagination={pagination}
        onSearch={handleSearch}
        onPageChange={handlePageChange}
        onSort={handleSort}
        isLoading={loading}
      />

      {!loading && submissions.length === 0 && !searchTerm && (
        <Card>
          <CardContent className="p-8 text-center">
            <Mail className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium mb-2">No Contact Submissions Yet</h3>
            <p className="text-muted-foreground">
              When users submit the contact form on your website, their messages will appear here.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}