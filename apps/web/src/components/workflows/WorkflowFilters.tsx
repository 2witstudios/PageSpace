'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { X, Filter } from 'lucide-react';

interface WorkflowFiltersProps {
  categories: string[];
  allTags: string[];
  onFilterChange: (filters: FilterState) => void;
}

export interface FilterState {
  category: string;
  tags: string[];
  searchQuery: string;
}

export function WorkflowFilters({
  categories,
  allTags,
  onFilterChange,
}: WorkflowFiltersProps) {
  const [category, setCategory] = useState<string>('');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    onFilterChange({
      category,
      tags: selectedTags,
      searchQuery,
    });
  }, [category, selectedTags, searchQuery, onFilterChange]);

  const handleTagToggle = (tag: string) => {
    setSelectedTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
    );
  };

  const handleClearFilters = () => {
    setCategory('');
    setSelectedTags([]);
    setSearchQuery('');
  };

  const hasActiveFilters = category || selectedTags.length > 0 || searchQuery;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div className="flex items-center gap-2">
          <Filter className="size-4" />
          <CardTitle className="text-base">Filters</CardTitle>
        </div>
        {hasActiveFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleClearFilters}
            className="h-8 px-2 text-xs"
          >
            Clear
          </Button>
        )}
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Search */}
        <div className="space-y-2">
          <Label htmlFor="search">Search</Label>
          <Input
            id="search"
            type="text"
            placeholder="Search workflows..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        {/* Category Filter */}
        <div className="space-y-2">
          <Label htmlFor="category">Category</Label>
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger id="category">
              <SelectValue placeholder="All categories" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">All categories</SelectItem>
              {categories.map((cat) => (
                <SelectItem key={cat} value={cat}>
                  {cat}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Tags Filter */}
        {allTags.length > 0 && (
          <div className="space-y-2">
            <Label>Tags</Label>
            <div className="flex flex-wrap gap-2">
              {allTags.map((tag) => (
                <Badge
                  key={tag}
                  variant={selectedTags.includes(tag) ? 'default' : 'outline'}
                  className="cursor-pointer hover:bg-primary/90"
                  onClick={() => handleTagToggle(tag)}
                >
                  {tag}
                  {selectedTags.includes(tag) && (
                    <X className="ml-1 size-3" />
                  )}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {/* Active Filters Summary */}
        {hasActiveFilters && (
          <div className="pt-2 border-t">
            <p className="text-xs text-muted-foreground mb-2">Active filters:</p>
            <div className="space-y-1 text-xs">
              {searchQuery && (
                <div className="flex items-center gap-1">
                  <span className="font-medium">Search:</span>
                  <span className="text-muted-foreground">{searchQuery}</span>
                </div>
              )}
              {category && (
                <div className="flex items-center gap-1">
                  <span className="font-medium">Category:</span>
                  <span className="text-muted-foreground">{category}</span>
                </div>
              )}
              {selectedTags.length > 0 && (
                <div className="flex items-center gap-1">
                  <span className="font-medium">Tags:</span>
                  <span className="text-muted-foreground">
                    {selectedTags.join(', ')}
                  </span>
                </div>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
