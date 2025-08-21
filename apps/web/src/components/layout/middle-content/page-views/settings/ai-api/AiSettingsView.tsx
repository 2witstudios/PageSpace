'use client';

export default function AiSettingsView() {
  return (
    <div className="container mx-auto py-10 space-y-10 px-10">
      <h1 className="text-3xl font-bold mb-6">AI API Keys</h1>
      <div className="rounded-lg border-2 border-dashed border-gray-300 p-6">
        <h3 className="text-lg font-medium mb-2">API Key Storage</h3>
        <p className="text-muted-foreground">
          AI functionality has been temporarily removed. API key storage will be available when AI features are re-implemented.
        </p>
      </div>
    </div>
  );
}