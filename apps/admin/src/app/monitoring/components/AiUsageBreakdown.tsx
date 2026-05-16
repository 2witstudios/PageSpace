import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  PieChart, Pie, Cell, LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer
} from 'recharts';
import { format } from 'date-fns';
import type { AiUsageData, DetailedWidgetProps } from '@/lib/monitoring';

type AiUsageBreakdownProps = DetailedWidgetProps<AiUsageData>;

const COLORS = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042', '#8884D8'];

export default function AiUsageBreakdown({ data, isLoading, detailed = false }: AiUsageBreakdownProps) {
  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>AI Usage</CardTitle>
          <CardDescription>Loading...</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="h-64 flex items-center justify-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
          </div>
        </CardContent>
      </Card>
    );
  }

  // Calculate total cost
  const totalCost = data?.costsByProvider?.reduce((sum, p) => 
    sum + (p.totalCost || 0), 0) || 0;

  // Format token usage data
  const tokenData = data?.tokenUsageOverTime?.map((item) => ({
    date: format(new Date(item.day), 'MMM dd'),
    tokens: parseInt(item.total_tokens) || 0,
    cost: parseFloat(item.total_cost) || 0,
  })).reverse() || [];

  // Format pie chart data
  const pieData = data?.costsByProvider?.map((item) => ({
    name: item.provider,
    value: item.totalCost || 0,
    requests: item.requestCount,
  })) || [];

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>AI Usage Overview</CardTitle>
          <CardDescription>
            Total cost: ${totalCost.toFixed(2)} | 
            Success rate: <Badge variant="secondary">{data?.successRate?.toFixed(1) || 0}%</Badge>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Cost by Provider Pie Chart */}
            <div>
              <h4 className="text-sm font-medium mb-2">Cost by Provider</h4>
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie
                    data={pieData}
                    cx="50%"
                    cy="50%"
                    labelLine={false}
                    label={({ name, value }: { name?: string; value?: number }) => `${name}: $${(value || 0).toFixed(2)}`}
                    outerRadius={80}
                    fill="#8884d8"
                    dataKey="value"
                  >
                    {pieData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            </div>

            {/* Top Spending Users */}
            <div>
              <h4 className="text-sm font-medium mb-2">Top Spenders</h4>
              <ScrollArea className="h-48">
                <div className="space-y-2">
                  {data?.topSpenders?.map((user, i) => (
                    <div key={i} className="flex justify-between items-center">
                      <span className="text-sm text-muted-foreground">
                        {user.userName}
                      </span>
                      <div className="flex gap-2">
                        <Badge variant="outline">{user.requestCount} requests</Badge>
                        <Badge variant="secondary">${user.totalCost?.toFixed(2) || '0.00'}</Badge>
                      </div>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </div>
          </div>
        </CardContent>
      </Card>

      {detailed && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Token Usage Trend</CardTitle>
              <CardDescription>Daily token consumption and costs</CardDescription>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={tokenData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" />
                  <YAxis yAxisId="left" />
                  <YAxis yAxisId="right" orientation="right" />
                  <Tooltip />
                  <Legend />
                  <Line 
                    yAxisId="left"
                    type="monotone" 
                    dataKey="tokens" 
                    stroke="#8884d8" 
                    name="Tokens"
                    strokeWidth={2}
                  />
                  <Line 
                    yAxisId="right"
                    type="monotone" 
                    dataKey="cost" 
                    stroke="#82ca9d" 
                    name="Cost ($)"
                    strokeWidth={2}
                  />
                </LineChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Model Popularity</CardTitle>
              <CardDescription>Most used AI models</CardDescription>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={data?.modelPopularity || []}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis 
                    dataKey="model" 
                    angle={-45}
                    textAnchor="end"
                    height={100}
                    tick={{ fontSize: 10 }}
                  />
                  <YAxis />
                  <Tooltip />
                  <Bar dataKey="usageCount" fill="#8884d8" name="Usage Count" />
                </BarChart>
              </ResponsiveContainer>
              
              <div className="mt-4 space-y-2">
                {data?.modelPopularity?.slice(0, 5).map((model, i) => (
                  <div key={i} className="flex justify-between items-center text-sm">
                    <span className="text-muted-foreground truncate max-w-xs">
                      {model.model}
                    </span>
                    <div className="flex gap-2">
                      <Badge variant="outline">{model.usageCount} uses</Badge>
                      <Badge variant="secondary">{model.totalTokens} tokens</Badge>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </>
  );
}