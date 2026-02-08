# Review Vector: Virtualized Lists

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- ui.mdc

## Scope
**Files**: `apps/web/src/components/**`
**Level**: component

## Context
PageSpace renders potentially large lists in the page tree, search results, activity feeds, message threads, and member lists that may require virtualization or windowing to maintain smooth scrolling performance. Components rendering unbounded data sets should use virtual scrolling techniques to only mount visible DOM nodes. The review should identify lists that grow with user data and assess whether they implement proper virtualization, handle dynamic row heights correctly, and maintain scroll position during data updates or when new items are prepended.
