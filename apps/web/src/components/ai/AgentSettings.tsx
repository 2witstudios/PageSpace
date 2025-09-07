import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Save, Sparkles } from 'lucide-react';
import { toast } from 'sonner';

interface AgentSettingsProps {
  pageId: string;
  currentPrompt?: string;
  onSave?: (prompt: string | null) => void;
}

export const AgentSettings: React.FC<AgentSettingsProps> = ({
  pageId,
  currentPrompt,
  onSave
}) => {
  const [systemPrompt, setSystemPrompt] = useState(currentPrompt || '');
  const [isSaving, setIsSaving] = useState(false);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      // First, check if there's already a system message (first row)
      const messagesResponse = await fetch(`/api/ai/messages/${pageId}`, {
        credentials: 'include',
      });
      
      let existingMessages = [];
      if (messagesResponse.ok) {
        existingMessages = await messagesResponse.json();
      }
      
      const hasSystemMessage = existingMessages[0]?.role === 'system';
      
      // Save or update the system prompt as first message
      if (systemPrompt) {
        if (hasSystemMessage) {
          // Update existing system message
          await fetch(`/api/ai/messages/${existingMessages[0].id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ content: systemPrompt }),
          });
        } else {
          // Create new system message as first row
          await fetch(`/api/ai/messages/${pageId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
              role: 'system',
              content: systemPrompt,
              // Set very early timestamp to ensure it sorts first
              createdAt: new Date(0).toISOString(),
            }),
          });
        }
      } else if (hasSystemMessage) {
        // Remove system message if prompt is cleared
        await fetch(`/api/ai/messages/${existingMessages[0].id}`, {
          method: 'DELETE',
          credentials: 'include',
        });
      }
      
      toast.success('Agent prompt saved successfully');
      if (onSave) {
        onSave(systemPrompt || null);
      }
    } catch (error) {
      console.error('Error saving agent settings:', error);
      toast.error('Failed to save agent settings');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="h-5 w-5" />
          AI Agent Configuration
        </CardTitle>
        <CardDescription>
          Configure this AI chat as a specialized agent with custom behavior and capabilities
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* System Prompt */}
        <div className="space-y-2">
          <Label htmlFor="system-prompt">System Prompt</Label>
          <Textarea
            id="system-prompt"
            placeholder="Enter a custom system prompt to define this agent's behavior, expertise, and personality..."
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            rows={6}
            className="font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground">
            This prompt defines the agent&apos;s role and behavior. Leave empty to use default behavior.
          </p>
        </div>

        {/* Save Button */}
        <div className="flex justify-end">
          <Button
            onClick={handleSave}
            disabled={isSaving}
          >
            {isSaving ? (
              <>
                <span className="animate-spin mr-2">⏳</span>
                Saving...
              </>
            ) : (
              <>
                <Save className="h-4 w-4 mr-2" />
                Save Agent Settings
              </>
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};