# PageSpace iOS Sidebar Redesign

## Overview
Complete redesign of the PageSpace mobile sidebar following minimal, modern aesthetic principles inspired by Claude Code and the web app's design system.

## Design Philosophy
- **Minimal & Clean**: Ghost buttons, no unnecessary backgrounds
- **Space Efficient**: Tighter spacing, removed visual clutter
- **Professional**: Refined typography with letter tracking
- **Brand Aligned**: Colors match web app's OKLCH palette
- **Visual Economy**: Function over decoration, calm over noise

## What Changed

### 1. **Design Tokens System** (`DesignTokens.swift`)
Created centralized design system with:

**Colors**:
- Brand blue matching web app: `hue: 0.653, saturation: 0.6, brightness: 0.70`
- Adaptive light/dark mode colors throughout
- Subtle backgrounds: `Color.gray.opacity(0.05)` for hover
- Extra subtle: `Color.gray.opacity(0.03)` for conversation hover
- Muted text colors with specific opacity values (0.7, 0.6)
- Hairline separators: `Color.gray.opacity(0.08)`

**Spacing**:
- Comprehensive scale: xxxsmall (2pt) → xxlarge (32pt)
- Sidebar width: 300pt (increased from 280pt for better breathing room)
- Item padding: 10pt vertical, 16pt horizontal (reduced from 12pt/16pt)
- Section headers: 12pt top, 4pt bottom

**Typography**:
- Letter tracking values for refined text rendering
- Body tracking: -0.2pt
- Heading tracking: -0.3pt

**Animation**:
- Quick transition: `.easeOut(duration: 0.15)` for instant feedback
- Standard transition: `.easeInOut(duration: 0.25)`
- Sidebar slide: `.easeInOut(duration: 0.3)`

### 2. **Sidebar Component** (`Sidebar.swift`)
Redesigned with minimal aesthetic:

**Navigation Buttons**:
- Replaced `NavigationButton` with `GhostNavigationButton`
- **No background by default** - completely transparent
- Subtle hover: Very light gray background on press
- Tighter spacing: 6pt between items (down from 8pt)
- Icon size: 20pt for better balance
- Clean typography with letter tracking

**Section Headers**:
- Removed icon (clock) for cleaner look
- Uppercase `.caption` font with `.semibold` weight
- Extra muted color (0.6 opacity) to reduce visual weight
- Minimal padding: 12pt top, 4pt bottom

**Dividers**:
- Replaced thick `Divider()` with hairline separators
- Height: 0.5pt
- Color: `Color.gray.opacity(0.08)` - barely visible

**User Profile Footer**:
- Simplified layout: Avatar + name only (removed email)
- Settings icon: Changed from rotated ellipsis to clean `gearshape.fill`
- Icon size: 16pt for subtlety
- Ghost button treatment (no background until tap)
- Uses brand blue gradient for avatar fallback

### 3. **Conversation List** (`ConversationList.swift`)
Minimal conversation row styling:

**ConversationRowButton Component**:
- Transparent by default
- **Selection indicator**: 2pt blue accent bar on left edge
- Hover state: Barely perceptible gray (`opacity(0.03)`)
- Active state: Subtle blue tint (`opacity(0.04)`)
- Selected items: Medium font weight for emphasis
- Smooth animations on press and selection

**Date Group Headers**:
- Uppercase `.caption2` with semibold weight
- Extra muted color to stay out of the way
- Smart spacing based on position (first group vs. others)

### 4. **Ghost Button System**
New reusable components for consistent interactions:

**GhostNavigationButton**:
- Icon + text layout with proper spacing
- Press state tracking with `@State`
- Animated background transitions
- Disabled state with 50% opacity
- "Soon" badge with minimal styling

**GhostButtonStyle**:
- Custom button style that tracks press state
- Used across navigation and conversation buttons
- Enables consistent hover/press animations

**ConversationRowButton**:
- Specialized for sidebar conversations
- 2pt blue accent bar for selection
- Three states: default, hover, selected
- Smooth cross-state animations

## Color Palette

### Light Mode
- Background: `Color(white: 0.98)` - subtle warmth
- Text: `.primary` (system)
- Muted text: `.secondary` with 0.7 opacity
- Extra muted: `.secondary` with 0.6 opacity
- Hover: `Color.gray.opacity(0.05)`
- Active: `brandBlue.opacity(0.04)`
- Separator: `Color.gray.opacity(0.08)`

### Dark Mode
- Background: `Color(white: 0.155)` - barely lifted
- Text: `.primary` (system, adapts)
- Muted text: `.secondary` with 0.7 opacity
- Extra muted: `.secondary` with 0.6 opacity
- Hover: Same as light mode
- Active: `brandBlueDark.opacity(0.06)` - slightly more visible
- Separator: Same as light mode

## Typography Hierarchy
1. **Section headers**: `.caption` + `.semibold` + uppercase
2. **Navigation items**: `.body` + `.medium` + tracking
3. **Conversation titles**: `.subheadline` + `.regular` (`.medium` when selected)
4. **User name**: `.subheadline` + `.medium`
5. **Metadata**: `.caption` + `.regular`
6. **Date groups**: `.caption2` + `.semibold` + uppercase

## Spacing Scale
- **2pt** (xxxsmall): Internal badge padding
- **4pt** (xxsmall): Minimal gaps, section header bottom
- **6pt** (xsmall): Navigation item spacing
- **8pt** (small): Conversation row vertical padding
- **12pt** (medium): Avatar → name spacing, section header top
- **16pt** (large): Sidebar horizontal padding, item horizontal padding
- **24pt** (xlarge): Larger gaps
- **32pt** (xxlarge): Major sections

## Files Modified
1. **Created**: `/apps/ios/PageSpace/Core/Utilities/DesignTokens.swift` - Design system tokens
2. **Updated**: `/apps/ios/PageSpace/Features/Navigation/Sidebar.swift` - Ghost button navigation
3. **Updated**: `/apps/ios/PageSpace/Features/Navigation/ConversationList.swift` - Minimal row styling
4. **Updated**: `/apps/ios/PageSpace/Features/Navigation/HomeView.swift` - Design token integration

## Build Status
✅ **Build succeeded** - All changes compile without errors

## Design Principles Applied
1. **Visual Economy**: Removed unnecessary backgrounds, borders, decorations
2. **Subtle Hierarchy**: Established through font weight, size, and opacity
3. **Calm Interface**: Muted colors, soft separators, gentle animations
4. **Quick Feedback**: 0.15s transitions for instant response
5. **Brand Consistency**: Colors and spacing aligned with web app
6. **Space Efficiency**: Tighter spacing, 300pt width for better content density
7. **Ghost Buttons**: Claude Code-style transparent buttons throughout

## Next Steps (Optional Enhancements)
1. **SF Pro Rounded**: Consider adopting SF Pro Rounded for softer feel
2. **Haptic Feedback**: Add subtle haptics on button presses
3. **Micro-animations**: Spring animations for sidebar slide
4. **Custom Icons**: Beyond SF Symbols for unique branding
5. **Loading States**: Skeleton screens for conversation loading
6. **Swipe Actions**: Delete/archive conversations with gestures

## Testing Checklist
- [x] Build compiles without errors
- [ ] Test in light mode
- [ ] Test in dark mode
- [ ] Test on iPhone (various sizes)
- [ ] Test on iPad
- [ ] Verify animations feel smooth
- [ ] Check touch targets (44pt minimum)
- [ ] Verify text readability at different sizes
- [ ] Test with VoiceOver for accessibility
- [ ] Test with Dynamic Type (larger text sizes)

---

**Design Date**: November 2, 2025
**Designer**: Claude Code
**Status**: ✅ Complete - Ready for testing
