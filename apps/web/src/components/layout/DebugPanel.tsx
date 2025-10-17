"use client";

import { useState } from 'react';
import { useLayoutStore } from '@/stores/useLayoutStore';
import { useDocumentManagerStore } from '@/stores/useDocumentManagerStore';
import { useNavigation } from '@/components/layout/NavigationProvider';
import { usePerformanceMonitor } from '@/hooks/usePerformanceMonitor';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { 
  Settings, 
  Database, 
  Navigation, 
  FileText, 
  Clock, 
  MemoryStick,
  Trash,
  RefreshCw,
  Bug,
  X,
  Activity
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

export function DebugPanel() {
  const [isOpen, setIsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'layout' | 'performance'>('layout');
  const layoutStore = useLayoutStore();
  const documentStore = useDocumentManagerStore();
  const { getMetrics, getAverageLoadTime, clearMetrics } = usePerformanceMonitor();
  
  // Navigation context is now always available
  const navigationContext = useNavigation();
  
  const metrics = getMetrics();
  const avgLoadTime = getAverageLoadTime();

  const clearCache = () => {
    layoutStore.clearCache();
    localStorage.removeItem('layout-storage');
    sessionStorage.clear();
    window.location.reload();
  };

  // Only show in development
  if (process.env.NODE_ENV !== 'development') {
    return null;
  }

  return (
    <>
      {/* Floating debug button */}
      <motion.button
        initial={{ scale: 0 }}
        animate={{ scale: 1 }}
        whileHover={{ scale: 1.1 }}
        whileTap={{ scale: 0.9 }}
        onClick={() => setIsOpen(!isOpen)}
        className="fixed bottom-4 right-4 z-50 w-12 h-12 bg-primary text-primary-foreground rounded-full shadow-lg flex items-center justify-center"
      >
        <Bug size={20} />
      </motion.button>

      {/* Debug panel */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, x: 400 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 400 }}
            transition={{ type: "spring", damping: 20 }}
            className="fixed top-0 right-0 h-full w-96 bg-background border-l shadow-xl z-40 overflow-y-auto"
          >
            <Card className="h-full rounded-none border-0">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <Settings size={20} />
                      Debug Panel
                    </CardTitle>
                    <CardDescription>
                      Development tools for performance & state
                    </CardDescription>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setIsOpen(false)}
                  >
                    <X size={16} />
                  </Button>
                </div>
                
                {/* Tab Navigation */}
                <div className="flex gap-2 mt-3">
                  <Button
                    variant={activeTab === 'layout' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setActiveTab('layout')}
                  >
                    <Database size={16} className="mr-1" />
                    Layout
                  </Button>
                  <Button
                    variant={activeTab === 'performance' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setActiveTab('performance')}
                  >
                    <Activity size={16} className="mr-1" />
                    Performance
                  </Button>
                </div>
              </CardHeader>

              <CardContent className="space-y-6">
                {activeTab === 'performance' ? (
                  <>
                    {/* Performance Metrics */}
                    <div className="space-y-3">
                      <h3 className="font-semibold flex items-center gap-2">
                        <Activity size={16} />
                        Performance Metrics
                      </h3>
                      <div className="space-y-2 text-sm">
                        <div className="grid grid-cols-2 gap-2">
                          <span className="text-muted-foreground">Avg Load Time:</span>
                          <span className={`font-mono ${avgLoadTime > 500 ? 'text-red-500' : avgLoadTime > 200 ? 'text-yellow-500' : 'text-green-500'}`}>
                            {avgLoadTime.toFixed(2)}ms
                          </span>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <span className="text-muted-foreground">Total Navigations:</span>
                          <span className="font-mono">{metrics.length}</span>
                        </div>
                      </div>
                    </div>

                    <Separator />

                    {/* Recent Routes */}
                    <div className="space-y-3">
                      <h3 className="font-semibold flex items-center gap-2">
                        <Clock size={16} />
                        Recent Routes
                      </h3>
                      {metrics.length > 0 ? (
                        <div className="space-y-2 max-h-40 overflow-y-auto">
                          {metrics.slice(0, 10).map((metric, index) => (
                            <div key={index} className="p-2 bg-muted rounded text-xs">
                              <div className="flex items-center justify-between">
                                <span className="font-mono truncate">{metric.route}</span>
                                <Badge variant={metric.loadTime > 500 ? "destructive" : metric.loadTime > 200 ? "secondary" : "default"}>
                                  {metric.loadTime.toFixed(0)}ms
                                </Badge>
                              </div>
                              <div className="text-muted-foreground mt-1">
                                {new Date(metric.timestamp).toLocaleTimeString()}
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-sm text-muted-foreground">No performance data yet</p>
                      )}
                    </div>

                    <Separator />

                    {/* Performance Actions */}
                    <div className="space-y-3">
                      <h3 className="font-semibold">Performance Actions</h3>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={clearMetrics}
                        className="w-full"
                      >
                        <Trash size={16} className="mr-2" />
                        Clear Performance Data
                      </Button>
                    </div>
                  </>
                ) : (
                  <>
                    {/* Layout System Toggle */}
                    <div className="space-y-3">
                      <h3 className="font-semibold flex items-center gap-2">
                        <Navigation size={16} />
                        Layout System
                      </h3>
                      <div className="flex items-center justify-between">
                        <span className="text-sm">Optimized Layout System</span>
                        <div className="flex items-center gap-2">
                          <Badge variant="default">
                            Active
                          </Badge>
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Performance-optimized state management with instant navigation
                      </p>
                    </div>

                <Separator />

                {/* Layout Store State */}
                  <div className="space-y-3">
                    <h3 className="font-semibold flex items-center gap-2">
                      <Database size={16} />
                      Layout Store
                    </h3>
                    <div className="space-y-2 text-sm">
                      <div className="grid grid-cols-2 gap-2">
                        <span className="text-muted-foreground">Active Drive:</span>
                        <span className="font-mono text-xs">
                          {layoutStore.activeDriveId || 'None'}
                        </span>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <span className="text-muted-foreground">Active Page:</span>
                        <span className="font-mono text-xs">
                          {layoutStore.activePageId || 'None'}
                        </span>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <span className="text-muted-foreground">View Type:</span>
                        <span className="capitalize">{layoutStore.centerViewType}</span>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <span className="text-muted-foreground">Left Sidebar:</span>
                        <Badge variant={layoutStore.leftSidebarOpen ? "default" : "secondary"}>
                          {layoutStore.leftSidebarOpen ? "Open" : "Closed"}
                        </Badge>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <span className="text-muted-foreground">Right Sidebar:</span>
                        <Badge variant={layoutStore.rightSidebarOpen ? "default" : "secondary"}>
                          {layoutStore.rightSidebarOpen ? "Open" : "Closed"}
                        </Badge>
                      </div>
                    </div>
                  </div>

                <Separator />

                {/* Document State */}
                  <div className="space-y-3">
                    <h3 className="font-semibold flex items-center gap-2">
                      <FileText size={16} />
                      Documents ({documentStore.documents.size})
                    </h3>
                    {documentStore.documents.size > 0 ? (
                      <div className="space-y-2 max-h-40 overflow-y-auto">
                        {Array.from(documentStore.documents.entries()).map(([id, doc]) => (
                          <div key={id} className="p-2 bg-muted rounded text-xs">
                            <div className="flex items-center justify-between">
                              <span className="font-mono truncate">{id}</span>
                              <Badge
                                variant={doc.isDirty ? "destructive" : "default"}
                                className="text-xs"
                              >
                                {doc.isDirty ? "Dirty" : "Clean"}
                              </Badge>
                            </div>
                            <div className="text-muted-foreground mt-1">
                              {doc.content.length} chars
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">No documents loaded</p>
                    )}
                  </div>

                <Separator />

                {/* Cache State */}
                  <div className="space-y-3">
                    <h3 className="font-semibold flex items-center gap-2">
                      <MemoryStick size={16} />
                      View Cache ({layoutStore.viewCache.size})
                    </h3>
                    {layoutStore.viewCache.size > 0 ? (
                      <div className="space-y-2 max-h-32 overflow-y-auto">
                        {Array.from(layoutStore.viewCache.entries()).map(([id, view]) => (
                          <div key={id} className="p-2 bg-muted rounded text-xs">
                            <div className="flex items-center justify-between">
                              <span className="font-mono truncate">{id}</span>
                              <Badge variant="outline">
                                {view.viewType}
                              </Badge>
                            </div>
                            <div className="text-muted-foreground mt-1">
                              <Clock size={12} className="inline mr-1" />
                              {new Date(view.timestamp).toLocaleTimeString()}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">No cached views</p>
                    )}
                  </div>

                <Separator />

                {/* Navigation State */}
                {navigationContext && (
                  <div className="space-y-3">
                    <h3 className="font-semibold flex items-center gap-2">
                      <Navigation size={16} />
                      Navigation
                    </h3>
                    <div className="space-y-2 text-sm">
                      <div className="grid grid-cols-2 gap-2">
                        <span className="text-muted-foreground">Navigation Ready:</span>
                        <Badge variant="default">
                          Yes
                        </Badge>
                      </div>
                    </div>
                  </div>
                )}

                <Separator />

                {/* Actions */}
                <div className="space-y-3">
                  <h3 className="font-semibold flex items-center gap-2">
                    <Settings size={16} />
                    Actions
                  </h3>
                  <div className="space-y-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={clearCache}
                      className="w-full"
                    >
                      <Trash size={16} className="mr-2" />
                      Clear Cache & Reload
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        console.log('Layout Store State:', layoutStore);
                        console.log('Navigation Context:', navigationContext);
                      }}
                      className="w-full"
                    >
                      <Bug size={16} className="mr-2" />
                      Log State to Console
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => window.location.reload()}
                      className="w-full"
                    >
                      <RefreshCw size={16} className="mr-2" />
                      Force Reload
                    </Button>
                  </div>
                </div>

                    {/* Debug Info */}
                    <div className="mt-6 p-3 bg-muted rounded text-xs">
                      <div className="font-semibold mb-2">Layout System Info:</div>
                      <div className="space-y-1">
                        <div>✅ Instant navigation with background loading</div>
                        <div>✅ Optimized animations replaced with CSS transitions</div>
                        <div>✅ Drive list caching with 5-minute TTL</div>
                        <div>✅ Performance monitoring active</div>
                      </div>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}