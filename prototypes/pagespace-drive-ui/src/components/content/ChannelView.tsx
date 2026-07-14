import { useState } from "react";
import type { ChatMessage } from "../../lib/pagespace";

interface ChannelViewProps {
  messages: ChatMessage[];
  canSend: boolean;
  sending: boolean;
  onSend: (content: string) => Promise<void>;
}

export function ChannelView({ messages, canSend, sending, onSend }: ChannelViewProps) {
  const [draft, setDraft] = useState("");

  const submit = async () => {
    if (!draft.trim()) return;
    await onSend(draft.trim());
    setDraft("");
  };

  return (
    <div className="channel-view">
      <div className="channel-messages">
        {messages.length === 0 && <p className="muted">No messages yet.</p>}
        {messages.map((m) => (
          <div key={m.id} className="channel-message">
            <div className="channel-message-head">
              <span className="channel-message-author">{m.user?.name ?? m.user?.email ?? "Unknown"}</span>
              <span className="channel-message-time">{new Date(m.createdAt).toLocaleString()}</span>
            </div>
            <p className="channel-message-body">{m.content}</p>
          </div>
        ))}
      </div>

      {canSend ? (
        <div className="channel-composer">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Send a message…"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <button type="button" onClick={submit} disabled={sending || !draft.trim()}>
            {sending ? "Sending…" : "Send"}
          </button>
        </div>
      ) : (
        <p className="muted">Sending messages to this page type isn't supported in this demo.</p>
      )}
    </div>
  );
}
