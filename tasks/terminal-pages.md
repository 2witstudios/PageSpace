# Terminal Pages Epic

**Status**: 📋 PLANNED
**Goal**: Add a TERMINAL page type that renders a live shell UI using Gridland (Canvas-based TUI renderer)

## Overview

Users need a terminal experience inside PageSpace for command execution and shell interaction. Today, PageSpace has no terminal/shell page type. Terminal pages fill this gap by rendering a full terminal UI using Gridland (@gridland/web) instead of xterm.js — rendering TUI-style interfaces directly to HTML5 Canvas via React + Yoga layout. The theme adapts to PageSpace's light/dark mode.

---

## Register TERMINAL page type

Add TERMINAL to the page type system across all required touchpoints.

**Requirements**:
- Given a new TERMINAL enum value, should be added to PageType enum, DB schema pgEnum, Zod validation schema, and page-types.config.ts
- Given terminal page config, should use `Terminal` lucide icon, 'terminal' layoutViewType, `TerminalView` uiComponent, and JSON default content for empty session state
- Given the CreatePageDialog, should include Terminal as a selectable page type
- Given the PageTypeIcon component, should map the Terminal icon

---

## Install and configure Gridland

Integrate @gridland/web into the Next.js app for Canvas-based TUI rendering.

**Requirements**:
- Given the apps/web package, should install @gridland/web and configure the Next.js plugin via withGridland in next.config.ts
- Given Gridland renders to Canvas, should dynamically import the Gridland renderer (no SSR) in the TerminalView component
- Given @gridland/ui components may be needed, should install the package and any required components (TextInput, Box, Text)

---

## Build TerminalView component

Create the core terminal UI component using Gridland's Canvas renderer.

**Requirements**:
- Given a terminal page is opened, should render a full-height Gridland Canvas with a terminal interface (prompt, output area, scrollback)
- Given the user types a command and presses Enter, should append the command to the session history and display it in the output area
- Given no backend PTY is connected yet, should display a placeholder response or "not connected" indicator
- Given the app theme changes between light/dark, should update the Gridland canvas theme to match
- Given the page content stores session history as JSON, should persist command history on save and restore on load

---

## Wire TerminalView into CenterPanel

Connect the new component to the page routing and rendering system.

**Requirements**:
- Given a page with type TERMINAL is selected, should render the TerminalView component via CenterPanel's componentMap
- Given TerminalView follows the pageId-only pattern (like CodePageView), should accept pageId prop and use useDocument for content persistence
- Given the terminal has unsaved session data, should register editing state with useEditingStore to prevent UI refresh conflicts
