interface TextViewProps {
  content: string;
  draft: string;
  onDraftChange: (value: string) => void;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  saving: boolean;
  saveMessage: string | null;
  onSave: () => void;
  monospace: boolean;
}

export function TextView({
  content,
  draft,
  onDraftChange,
  editing,
  onEditingChange,
  saving,
  saveMessage,
  onSave,
  monospace,
}: TextViewProps) {
  if (!editing) {
    return (
      <div className="text-view">
        <div className="text-view-toolbar">
          <button type="button" onClick={() => onEditingChange(true)}>
            Edit
          </button>
        </div>
        {content ? (
          <pre className={monospace ? "prose prose-mono" : "prose"}>{content}</pre>
        ) : (
          <p className="muted">Empty — click Edit to add content.</p>
        )}
      </div>
    );
  }

  return (
    <div className="text-view">
      <textarea
        className={monospace ? "editor-textarea mono" : "editor-textarea"}
        value={draft}
        onChange={(e) => onDraftChange(e.target.value)}
        rows={20}
        spellCheck={false}
        autoFocus
      />
      <div className="editor-actions">
        <button type="button" onClick={onSave} disabled={saving || draft === content}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={() => onEditingChange(false)} disabled={saving}>
          Done
        </button>
        {saveMessage && <span className="muted">{saveMessage}</span>}
      </div>
    </div>
  );
}
