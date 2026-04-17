# Notification Item Redesign Epic

**Status**: ✅ COMPLETED (2026-04-17)
**Goal**: Redesign the notification item so alignment, contrast, and state are consistent across the dropdown and the full-page list, for every notification type, in both light and dark mode.

## Overview

Notifications are a high-frequency surface; when they look unfinished, every refresh erodes trust in the rest of the product. Today the dropdown and the `/notifications` page re-implement the same item independently, drift on icon coverage, position the unread dot outside the card, use hardcoded Tailwind colors (`text-blue-500`, `bg-amber-500/10`) that break theming and WCAG, and ship without tests. This epic consolidates both surfaces onto a single `NotificationItem` component on a real grid with theme-token contrast, a predictable unread slot, and coverage for every type in the `NotificationType` enum.

---

## Shared NotificationItem component

Extract a single presentational component that both the dropdown and the full page render.

**Requirements**:
- Given the dropdown and the full `/notifications` page, should render notifications through the same component so icon coverage, alignment, and states cannot drift between surfaces.
- Given a caller that needs a denser dropdown variant and a roomier page variant, should expose a variant prop without duplicating layout logic.
- Given any notification type in the `NotificationType` enum, should render a sensible icon, title, body, and timestamp without falling through to a generic default.

---

## Grid-aligned layout

Place avatar/icon, content stack, unread indicator, and dismiss control on a deterministic grid so nothing floats.

**Requirements**:
- Given a notification with or without an unread state, should keep the title/body/meta left baseline in the exact same position so the list does not jitter when items are marked read.
- Given a notification with a long title or body, should truncate or wrap inside its grid cell without pushing the dismiss control off the card.
- Given the unread indicator, should sit in a reserved slot that is always present in the DOM (hidden when read) rather than absolutely positioned against the card edge.
- Given the dismiss control, should occupy a fixed slot that is keyboard-reachable and visible on focus, not only on pointer hover.

---

## Theme-token contrast

Replace hardcoded color classes with semantic tokens so theming and contrast work.

**Requirements**:
- Given the notification surface in light or dark mode, should style title, body, and meta only via `text-foreground` / `text-muted-foreground` / `bg-card` / `bg-accent` / `border-border` / `bg-primary` tokens, with no literal color utilities (`text-blue-500`, `bg-amber-500/10`, etc.).
- Given any supported notification type, should color-code by icon semantics only, without introducing per-type hardcoded background or text colors that bypass the theme.
- Given the rendered item in both themes, should pass WCAG AA contrast for title, body, and meta text against their surface.

---

## Read / unread / hover state distinction

Make the three states visually intentional and mutually distinguishable.

**Requirements**:
- Given a read vs. unread notification side by side, should show a difference that survives a grayscale screenshot (not color-only) so the cue is accessible.
- Given a pointer hovering a notification, should present a hover surface that is clearly different from both the read and unread resting states without shifting any text.
- Given an unread notification that the user clicks, should transition to the read state without layout shift, reserved-slot dot simply hiding in place.

---

## Notification type coverage

Guarantee every enum value has a defined icon, title source, and test.

**Requirements**:
- Given a new notification type added to the `NotificationType` enum, should surface a TypeScript error at the icon mapping if no icon is assigned, so coverage gaps are caught at compile time rather than as a generic fallback at runtime.
- Given each of the 15 current notification types (`PERMISSION_GRANTED`, `PERMISSION_REVOKED`, `PERMISSION_UPDATED`, `PAGE_SHARED`, `DRIVE_INVITED`, `DRIVE_JOINED`, `DRIVE_ROLE_CHANGED`, `CONNECTION_REQUEST`, `CONNECTION_ACCEPTED`, `CONNECTION_REJECTED`, `NEW_DIRECT_MESSAGE`, `EMAIL_VERIFICATION_REQUIRED`, `TOS_PRIVACY_UPDATED`, `MENTION`, `TASK_ASSIGNED`), should render with a non-default icon and navigate to the correct destination on click.
- Given a `CONNECTION_REQUEST`, should continue to expose Accept / Decline inline actions inside the grid without breaking alignment of sibling items.

---

## Tests

Colocate a rendering test per type and state.

**Requirements**:
- Given each notification type, should have a rendering test that asserts the correct icon, title, body, and meta are shown.
- Given read vs. unread state, should have a test that asserts the reserved unread-dot slot is populated only when unread and that the content stack's left edge does not move between states.
- Given a `CONNECTION_REQUEST`, should have a test that asserts Accept and Decline controls are rendered and clickable without toggling the parent navigation handler.

---
