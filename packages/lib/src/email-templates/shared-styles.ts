/**
 * Shared Email Styles
 *
 * Centralized styling for all PageSpace transactional emails.
 * Colors matched to the website's OKLCH design system (converted to RGB for email compatibility).
 */

// Brand Colors - Precisely matched to PageSpace's OKLCH design system
export const colors = {
  // Primary blue - converted from oklch(0.50 0.16 235)
  primary: '#3D64C8',         // Rich, saturated blue
  primaryLight: '#5178D4',    // For gradients
  primaryForeground: '#FFFFFF',

  // Backgrounds - matching liquid glass aesthetic
  pageBackground: '#F8F9FB',  // oklch(0.995 0.002 240) converted
  cardBackground: '#FFFFFF',
  headerGradientStart: '#3D64C8',
  headerGradientEnd: '#5178D4',

  // Text - precise conversion from OKLCH
  heading: '#111723',         // oklch(0.15 0.01 220)
  text: '#2C3442',            // Slightly lighter for body
  mutedText: '#697386',       // oklch(0.48 0.015 220) converted

  // Borders & Dividers - matching website
  border: '#E4E6EA',          // oklch(0.90 0.005 230) converted
  divider: '#F0F1F4',

  // Accents
  accent: '#F0F1F4',          // oklch(0.94 0.003 230)
  accentBorder: '#3D64C8',

  // Links
  link: '#3D64C8',
  linkHover: '#2E4FA8',
};

// Typography - refined for premium feel
export const typography = {
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',

  // Font sizes
  h1: '26px',
  h2: '21px',
  h3: '18px',
  body: '16px',
  small: '14px',
  tiny: '13px',

  // Line heights
  headingLineHeight: '1.3',
  bodyLineHeight: '1.65',

  // Font weights
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
};

// Spacing
export const spacing = {
  xs: '8px',
  sm: '12px',
  md: '16px',
  lg: '24px',
  xl: '32px',
  xxl: '40px',
};

// Border radius
export const radius = {
  sm: '4px',
  md: '8px',
  lg: '10px',
};

// Shadows - soft, ambient (matching website's liquid glass aesthetic)
export const shadows = {
  sm: '0 1px 2px rgba(0, 0, 0, 0.04)',
  md: '0 1px 3px rgba(0, 0, 0, 0.04), 0 8px 24px rgba(0, 0, 0, 0.06)',
  lg: '0 2px 8px rgba(0, 0, 0, 0.06), 0 16px 48px rgba(0, 0, 0, 0.08)',
  button: '0 2px 8px rgba(61, 100, 200, 0.24), 0 1px 2px rgba(61, 100, 200, 0.16)',
};

/**
 * Email Container Styles
 */
export const emailStyles = {
  // Main body - refined background
  main: {
    backgroundColor: colors.pageBackground,
    fontFamily: typography.fontFamily,
    WebkitFontSmoothing: 'antialiased' as const,
    MozOsxFontSmoothing: 'grayscale' as const,
    padding: `${spacing.lg} ${spacing.md}`,
  },

  // Container wrapper - elevated card with shadow
  container: {
    margin: '0 auto',
    maxWidth: '600px',
    boxShadow: shadows.md,
    borderRadius: radius.lg,
    overflow: 'hidden',
  },

  // Header section - liquid glass inspired gradient
  header: {
    background: `linear-gradient(135deg, ${colors.headerGradientStart} 0%, ${colors.headerGradientEnd} 100%)`,
    borderRadius: `${radius.lg} ${radius.lg} 0 0`,
    padding: `${spacing.xxl} ${spacing.lg}`,
    textAlign: 'center' as const,
    boxShadow: '0 1px 0 rgba(255, 255, 255, 0.1) inset',
  },

  // Header logo/title - bright white on gradient
  headerTitle: {
    color: colors.primaryForeground,
    fontSize: typography.h1,
    fontWeight: typography.bold,
    margin: '0',
    letterSpacing: '-0.8px',
    textShadow: '0 1px 2px rgba(0, 0, 0, 0.1)',
  },

  // Content section - crisp white with subtle shadow
  content: {
    backgroundColor: colors.cardBackground,
    padding: `${spacing.xxl} ${spacing.xl}`,
    boxShadow: '0 1px 3px rgba(0, 0, 0, 0.02)',
  },

  // Content heading - refined typography
  contentHeading: {
    fontSize: typography.h2,
    fontWeight: typography.semibold,
    color: colors.heading,
    margin: `0 0 ${spacing.lg} 0`,
    lineHeight: typography.headingLineHeight,
    letterSpacing: '-0.4px',
  },

  // Paragraph
  paragraph: {
    fontSize: typography.body,
    lineHeight: typography.bodyLineHeight,
    color: colors.text,
    margin: `0 0 ${spacing.md} 0`,
  },

  // Small paragraph (hints, notes)
  hint: {
    fontSize: typography.small,
    lineHeight: typography.bodyLineHeight,
    color: colors.mutedText,
    margin: `${spacing.lg} 0 0 0`,
  },

  // Message box (for quoted content)
  messageBox: {
    backgroundColor: colors.accent,
    borderLeft: `4px solid ${colors.accentBorder}`,
    padding: `${spacing.md} ${spacing.lg}`,
    margin: `${spacing.lg} 0`,
    borderRadius: radius.sm,
  },

  messageText: {
    fontSize: typography.body,
    lineHeight: typography.bodyLineHeight,
    color: colors.text,
    fontStyle: 'italic' as const,
    margin: '0',
  },

  // Button container
  buttonContainer: {
    textAlign: 'center' as const,
    margin: `${spacing.xl} 0`,
  },

  // Primary button - premium with gradient and depth
  button: {
    background: `linear-gradient(135deg, ${colors.primary} 0%, ${colors.primaryLight} 100%)`,
    borderRadius: '8px',
    color: colors.primaryForeground,
    fontSize: '15px',
    fontWeight: typography.semibold,
    textDecoration: 'none',
    textAlign: 'center' as const,
    display: 'inline-block',
    padding: '14px 32px',
    lineHeight: '1.4',
    letterSpacing: '0.3px',
    boxShadow: shadows.button,
    border: 'none',
    textShadow: '0 1px 1px rgba(0, 0, 0, 0.1)',
  },

  // Link
  link: {
    color: colors.link,
    textDecoration: 'underline',
    wordBreak: 'break-all' as const,
  },

  // Footer section - subtle and refined
  footer: {
    backgroundColor: colors.cardBackground,
    borderRadius: `0 0 ${radius.lg} ${radius.lg}`,
    padding: `${spacing.xl} ${spacing.xl}`,
    borderTop: `1px solid ${colors.divider}`,
  },

  // Footer text - understated
  footerText: {
    fontSize: typography.small,
    lineHeight: '1.7',
    color: colors.mutedText,
    margin: `${spacing.sm} 0`,
    textAlign: 'center' as const,
  },

  // Divider
  divider: {
    borderTop: `1px solid ${colors.border}`,
    margin: `${spacing.lg} 0`,
  },
};

/**
 * Utility: Create a styled divider
 */
export const divider = {
  borderTop: `1px solid ${colors.border}`,
  margin: `${spacing.lg} 0`,
};
