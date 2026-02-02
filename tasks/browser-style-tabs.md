# Browser-Style Tabs Epic

**Status**: ✅ COMPLETE (9/9 tasks complete)
**Goal**: Transform tabs into browser-like navigation contexts with per-tab history

## Overview

Users need tabs that behave like browser tabs—each maintaining its own navigation state rather than being tied to specific pages. This enables workspace templates, deliberate tab creation via Cmd+N, and navigation within tabs instead of tab proliferation. Currently tabs are page-centric (driveId + pageId), which limits what can be tabbed and causes clutter when users want to view many items.

---

## Task: Tab Model Refactor

Refactor the Tab interface from page-based to path-based with navigation history.

**Requirements**:
- Given a Tab, should store `path` (current route) instead of `driveId`/`pageId`/`type`
- Given a Tab, should maintain `history` array and `historyIndex` for back/forward
- Given `createTab()`, should create new tab at `/dashboard` by default
- Given `navigateInTab(tabId, path)`, should update path and push to history
- Given `goBack(tabId)`, should navigate to previous history entry
- Given `goForward(tabId)`, should navigate to next history entry

---

## Task: Tab Title Derivation

Create utility to derive tab title and icon from path.

**Requirements**:
- Given a page path like `/dashboard/[driveId]/[pageId]`, should return page title from store/cache
- Given a special path like `/dashboard/[driveId]/tasks`, should return "Tasks" with appropriate icon
- Given `/dashboard/messages`, should return "Messages"
- Given `/settings`, should return "Settings"
- Given unknown path, should return sensible fallback

---

## Task: Update Tab Sync Hook

Refactor useTabSync to update active tab's path instead of creating new tabs.

**Requirements**:
- Given URL navigation with existing tabs, should update active tab's path
- Given URL navigation with no tabs, should create a tab with that path
- Given external deep link, should create tab for that path
- Given modifier key navigation (handled elsewhere), should NOT intercept

---

## Task: Navigation Utility Functions

Create composable navigation utilities for consistent behavior across components.

**Requirements**:
- Given `navigateInCurrentTab(path)`, should update active tab's path and push to router
- Given `openInNewTab(path)`, should create new tab with path and activate it
- Given `openInBackgroundTab(path)`, should create new tab without activating
- Given modifier key detection, should return whether Cmd/Ctrl or middle-click occurred

---

## Task: Update Sidebar Navigation - PageTreeItem

Update PageTreeItem (reference implementation) to use new navigation model.

**Requirements**:
- Given normal click, should navigate within current tab
- Given Cmd/Ctrl+click, should open in new tab
- Given middle-click, should open in new tab
- Given context menu "Open in new tab", should open in new tab

---

## Task: Update Sidebar Navigation - Remaining Components

Apply navigation pattern to RecentsSection, FavoritesSection, DriveList, DriveFooter.

**Requirements**:
- Given normal click on any sidebar item, should navigate within current tab
- Given Cmd/Ctrl+click on any sidebar item, should open in new tab
- Given right-click on navigable item, should show "Open in new tab" option

---

## Task: Update Content Navigation

Apply navigation pattern to Breadcrumbs, ListView, GridView, mentions.

**Requirements**:
- Given click on breadcrumb, should navigate within current tab
- Given Cmd/Ctrl+click on folder item, should open in new tab
- Given click on page mention in document, should navigate within current tab

---

## Task: New Tab Creation UI

Add UI for creating new tabs.

**Requirements**:
- Given click on "+" button in tab bar, should create new tab at dashboard
- Given Cmd+T (browser) or Cmd+N (desktop), should create new tab
- Given last tab closed, should create new tab at dashboard (never zero tabs)
- Given "Duplicate Tab" action, should clone current tab's path

---

## Task: TabBar and TabItem Updates

Update tab rendering to work with path-based model.

**Requirements**:
- Given a tab, should display derived title and icon from path
- Given tab with loading title, should show path-based fallback
- Given back/forward keyboard shortcuts (Cmd+[ / Cmd+]), should navigate in active tab

---
