import { useState } from "react";
import type { PageType } from "../lib/pagespace";

const PAGE_TYPES: PageType[] = ["DOCUMENT", "FOLDER", "CANVAS", "CODE", "SHEET", "CHANNEL", "TASK_LIST", "AI_CHAT", "FILE"];

interface NewPageFormProps {
  onSubmit: (title: string, type: PageType) => Promise<void>;
  onCancel: () => void;
}

export function NewPageForm({ onSubmit, onCancel }: NewPageFormProps) {
  const [title, setTitle] = useState("");
  const [type, setType] = useState<PageType>("DOCUMENT");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!title.trim()) return;
    setBusy(true);
    try {
      await onSubmit(title.trim(), type);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="inline-form">
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Page title"
        autoFocus
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
      />
      <select value={type} onChange={(e) => setType(e.target.value as PageType)}>
        {PAGE_TYPES.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      <button type="button" onClick={submit} disabled={busy || !title.trim()}>
        Create
      </button>
      <button type="button" onClick={onCancel} disabled={busy}>
        Cancel
      </button>
    </div>
  );
}
