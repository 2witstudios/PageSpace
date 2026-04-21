import type { Domain } from "./types";

const DOMAIN_MAP: Record<string, Domain> = {
  "core.ts": { key: "core", label: "Core", color: "#4d8eff" },
  "auth.ts": { key: "auth", label: "Auth", color: "#a78bfa" },
  "sessions.ts": { key: "auth", label: "Auth", color: "#a78bfa" },
  "members.ts": { key: "members", label: "Members", color: "#22d3ee" },
  "permissions.ts": { key: "members", label: "Members", color: "#22d3ee" },
  "conversations.ts": { key: "conversations", label: "Conversations", color: "#3dd68c" },
  "chat.ts": { key: "chat", label: "Chat", color: "#3dd68c" },
  "social.ts": { key: "social", label: "Social", color: "#ff4d6a" },
  "tasks.ts": { key: "tasks", label: "Tasks", color: "#ffb84d" },
  "workflows.ts": { key: "workflows", label: "Workflows", color: "#ffb84d" },
  "storage.ts": { key: "storage", label: "Storage", color: "#22d3ee" },
  "integrations.ts": { key: "integrations", label: "Integrations", color: "#a78bfa" },
  "notifications.ts": { key: "notifications", label: "Notifications", color: "#ffb84d" },
  "email-notifications.ts": { key: "notifications", label: "Notifications", color: "#ffb84d" },
  "push-notifications.ts": { key: "notifications", label: "Notifications", color: "#ffb84d" },
  "calendar.ts": { key: "calendar", label: "Calendar", color: "#4d8eff" },
  "calendar-triggers.ts": { key: "calendar", label: "Calendar", color: "#4d8eff" },
  "versioning.ts": { key: "versioning", label: "Versioning", color: "#a78bfa" },
  "monitoring.ts": { key: "monitoring", label: "Monitoring", color: "#ff4d6a" },
  "security-audit.ts": { key: "monitoring", label: "Monitoring", color: "#ff4d6a" },
  "subscriptions.ts": { key: "billing", label: "Billing", color: "#3dd68c" },
  "ai.ts": { key: "ai", label: "AI", color: "#22d3ee" },
  "personalization.ts": { key: "ai", label: "AI", color: "#22d3ee" },
  "dashboard.ts": { key: "prefs", label: "Preferences", color: "#8b8ba0" },
  "display-preferences.ts": { key: "prefs", label: "Preferences", color: "#8b8ba0" },
  "hotkeys.ts": { key: "prefs", label: "Preferences", color: "#8b8ba0" },
  "page-views.ts": { key: "prefs", label: "Preferences", color: "#8b8ba0" },
  "contact.ts": { key: "misc", label: "Misc", color: "#8b8ba0" },
  "feedback.ts": { key: "misc", label: "Misc", color: "#8b8ba0" },
};

const DEFAULT: Domain = { key: "misc", label: "Misc", color: "#8b8ba0" };

export const getDomain = (file: string): Domain => DOMAIN_MAP[file] ?? DEFAULT;

export const getAllDomains = (): Domain[] => {
  const seen = new Map<string, Domain>();
  for (const d of Object.values(DOMAIN_MAP)) {
    if (!seen.has(d.key)) seen.set(d.key, d);
  }
  return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label));
};
