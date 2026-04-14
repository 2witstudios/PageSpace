# GitHub Import Tool Removal Epic

**Status**: PLANNED
**Goal**: Remove the broken GitHub import AI tool while keeping agent configuration stable.

## Overview

WHY users should not be offered a broken GitHub import path in chat or the global assistant, and existing agents with stale GitHub import tool references should remain editable without manual cleanup.

---

## Remove Broken Tool

Remove the AI-exposed GitHub import tool and sanitize obsolete references during agent configuration updates.

**Requirements**:
- Given PageSpace AI tools, should not expose the broken GitHub import tool to page chat or the global assistant
- Given an AI agent with a stale `import_from_github` tool reference, should allow valid configuration updates without failing on that obsolete tool name
- Given an agent config update request with malformed `enabledTools`, should reject the request instead of persisting an invalid tool shape

---
