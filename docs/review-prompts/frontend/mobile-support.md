# Review Vector: Mobile Support

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- ui.mdc

## Scope
**Files**: `apps/web/src/hooks/useMobile*.ts`, `apps/web/src/hooks/useCapacitor.ts`, `apps/web/src/hooks/useIOSKeyboardInit.ts`, `apps/web/src/lib/capacitor-bridge.ts`
**Level**: component

## Context
PageSpace supports mobile deployment through a Capacitor bridge that wraps the web application for native iOS and Android. The useCapacitor hook detects the native runtime environment, useIOSKeyboardInit handles iOS virtual keyboard behavior that affects viewport sizing, and useMobileKeyboard manages keyboard show/hide events. The capacitor-bridge.ts module abstracts native API calls for file access, haptics, and status bar control. Mobile-specific code paths must degrade gracefully when running in a standard browser without the native layer.
