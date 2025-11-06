'use client';

import { useState, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useWorkflowTemplates } from '@/hooks/workflows';
import { WorkflowTemplateList } from './WorkflowTemplateList';
import { WorkflowFilters, type FilterState } from './WorkflowFilters';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertCircle, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function WorkflowsPageClient() {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<'discover' | 'my-workflows'>(
    'discover'
  );
  const [filters, setFilters] = useState<FilterState>({
    category: '',
    tags: [],
    searchQuery: '',
  });

  // Fetch all templates (we'll filter on the client side for better UX)
  const { templates: allTemplates, isLoading, isError, refresh } = useWorkflowTemplates();

  // Extract unique categories and tags from all templates
  const { categories, tags } = useMemo(() => {
    const categorySet = new Set<string>();
    const tagSet = new Set<string>();

    allTemplates.forEach((template) => {
      if (template.category) {
        categorySet.add(template.category);
      }
      if (template.tags) {
        template.tags.forEach((tag) => tagSet.add(tag));
      }
    });

    return {
      categories: Array.from(categorySet).sort(),
      tags: Array.from(tagSet).sort(),
    };
  }, [allTemplates]);

  // Client-side filtering
  const filteredTemplates = useMemo(() => {
    return allTemplates.filter((template) => {
      // Search filter
      if (filters.searchQuery) {
        const query = filters.searchQuery.toLowerCase();
        const matchesName = template.name.toLowerCase().includes(query);
        const matchesDescription = template.description
          ?.toLowerCase()
          .includes(query);
        if (!matchesName && !matchesDescription) {
          return false;
        }
      }

      // Category filter
      if (filters.category && template.category !== filters.category) {
        return false;
      }

      // Tags filter (template must have ALL selected tags)
      if (filters.tags.length > 0) {
        const templateTags = template.tags || [];
        const hasAllTags = filters.tags.every((tag) =>
          templateTags.includes(tag)
        );
        if (!hasAllTags) {
          return false;
        }
      }

      // Tab-specific filters
      if (activeTab === 'discover') {
        // Show public templates
        return template.isPublic;
      }

      return true;
    });
  }, [allTemplates, filters, activeTab]);

  const handleFilterChange = useCallback((newFilters: FilterState) => {
    setFilters(newFilters);
  }, []);

  if (isError) {
    return (
      <div className="container mx-auto py-8 px-4">
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertDescription>
            Failed to load workflow templates. Please try again.
          </AlertDescription>
        </Alert>
        <div className="flex justify-center mt-4">
          <Button onClick={refresh} variant="outline">
            Retry
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto py-8 px-4">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold mb-2">Workflow Templates</h1>
          <p className="text-muted-foreground">
            Discover and run workflow templates to automate complex tasks
          </p>
        </div>
        <Button onClick={() => router.push('/workflows/new')}>
          <Plus className="size-4 mr-2" />
          Create Workflow
        </Button>
      </div>

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as typeof activeTab)}>
        <TabsList className="mb-6">
          <TabsTrigger value="discover">Discover</TabsTrigger>
          <TabsTrigger value="my-workflows">My Workflows</TabsTrigger>
        </TabsList>

        <TabsContent value={activeTab} className="space-y-0">
          <div className="flex flex-col lg:flex-row gap-6">
            {/* Filters Sidebar */}
            <aside className="lg:w-64 shrink-0">
              <div className="sticky top-4">
                <WorkflowFilters
                  categories={categories}
                  allTags={tags}
                  onFilterChange={handleFilterChange}
                />
              </div>
            </aside>

            {/* Main Content */}
            <main className="flex-1 min-w-0">
              <WorkflowTemplateList
                templates={filteredTemplates}
                isLoading={isLoading}
              />
            </main>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
