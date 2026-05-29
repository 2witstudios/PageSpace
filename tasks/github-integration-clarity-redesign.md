# GitHub Integration Clarity & Token-Efficiency Redesign Epic

**Status**: 📋 PLANNED
**Goal**: Make the GitHub integration legible to set up and cheap for the AI to navigate, via shared "tool bundles".

## Overview

WHY the GitHub integration works but is opaque on both ends: the connect dialog never says agents act as you, what scopes are granted, or where capabilities are actually capped, and the per-agent capability lever is a buried flat list of 19 raw checkboxes; meanwhile the AI sees 19 always-loaded tools whose names carry a meaningless random connection-id segment and use inconsistent verbs, wasting tokens and making the toolset hard to navigate. The unifying fix is named tool bundles (Read-only, Code review, Issue triage, Full) defined once at the provider level, which give the UI one-click presets and make agents load only the tools they need.

---

## Tool Bundles Foundation

Add a `ToolBundle` type and define GitHub bundles plus plain-English OAuth scope descriptions on the provider config.

**Requirements**:
- Given the GitHub provider, should define Read-only, Code review, Issue triage, and Full-access bundles whose tool ids reference only tools that exist on the provider
- Given the connect dialog must explain access, should expose each OAuth scope as a plain-English description on the provider config
- Given a provider that defines no bundles, should leave existing per-tool grant behavior unchanged

---

## Consistent Tool Naming

Rename GitHub tools to a consistent verb convention and remap the ids stored in live grants.

**Requirements**:
- Given GitHub collection-returning tools, should name them with a `list_` verb and single-resource tools with a `get_` verb
- Given live agent grants that reference a renamed tool id, should rewrite that id in stored allowed/denied tool arrays so no agent silently loses a granted capability

---

## Compact Tool Names

Drop the connection-id segment from AI-visible integration tool names, with deterministic collision handling.

**Requirements**:
- Given an agent with a single connection for a provider, should expose tool names without a connection-id segment
- Given an agent with two or more active connections to the same provider, should disambiguate colliding tool names deterministically
- Given the compact naming scheme, should execute each tool via its closure-bound connection rather than by parsing the tool name

---

## Safe Default Bundle

Default a newly enabled integration to the Read-only bundle instead of every non-dangerous tool.

**Requirements**:
- Given an integration newly enabled on an agent, should grant the Read-only bundle by default

---

## Expose Bundles & Scopes via API

Surface bundles and scope descriptions through the integration API sanitizers and client types.

**Requirements**:
- Given the agent-integrations and provider-listing endpoints, should include tool bundles and scope descriptions in the sanitized provider payload without leaking execution or credential configuration

---

## Connect Dialog Redesign

Rework the connect dialog so the user understands identity, access, and where capabilities are capped.

**Requirements**:
- Given a user connecting GitHub, should state that granted agents act under the user's GitHub identity before authorization
- Given the scopes a connection requests, should present them as plain-English access descriptions rather than raw scope strings
- Given the visibility control, should frame it as who can use the connection and clarify that per-agent tools decide what agents can actually do

---

## Grant Panel Presets & Grouping

Give the per-agent grant panel bundle presets, category grouping, and a capability summary.

**Requirements**:
- Given a connection with defined bundles, should offer one-click presets that set the agent's allowed tools to a bundle
- Given an allowed-tools set matching no bundle, should label the selection as Custom
- Given the per-tool list, should group tools by category and show a plain-English summary of what the agent can do

---

## Scope Model Copy

Explain the three-layer scope model on the integration settings surfaces.

**Requirements**:
- Given the user and drive integration settings surfaces, should explain the connection → visibility → per-agent-tools model in one place

---
