//
//  DesignTokens.swift
//  PageSpace
//
//  Created by Claude
//  Design system tokens matching web app aesthetic
//

import SwiftUI

/// Centralized design system tokens for PageSpace mobile app
/// Inspired by the web app's OKLCH color system and minimal aesthetic
struct DesignTokens {

    // MARK: - Colors

    struct Colors {
        // MARK: Brand Colors
        /// Primary brand blue - matches web app's oklch(0.50 0.16 235)
        static let brandBlue = Color(hue: 0.653, saturation: 0.6, brightness: 0.70)
        static let brandBlueDark = Color(hue: 0.653, saturation: 0.5, brightness: 0.75)

        /// Primary color with light/dark mode support
        static var primary: Color {
            adaptiveColor(light: brandBlue, dark: brandBlueDark)
        }

        // MARK: Backgrounds
        /// Sidebar background - subtle warmth in light, lifted in dark
        static var sidebarBackground: Color {
            adaptiveColor(light: Color(white: 0.98), dark: Color(white: 0.155))
        }

        /// Hover state background - very subtle
        static var hoverBackground: Color {
            Color.gray.opacity(0.05)
        }

        /// Active/selected state background - subtle blue tint
        static var activeBackground: Color {
            adaptiveColor(light: brandBlue.opacity(0.04), dark: brandBlueDark.opacity(0.06))
        }

        /// Conversation item hover - barely perceptible
        static var conversationHover: Color {
            Color.gray.opacity(0.03)
        }

        // MARK: Text Colors
        /// Muted text for secondary information
        static var mutedText: Color {
            Color.secondary.opacity(0.7)
        }

        /// Extra muted for section headers
        static var extraMutedText: Color {
            Color.secondary.opacity(0.6)
        }

        // MARK: Borders & Separators
        /// Hairline separator - inspired by web app's separator tokens
        static var separator: Color {
            Color.gray.opacity(0.08)
        }

        /// Active accent bar for selected items
        static var accentBar: Color {
            primary
        }

        // MARK: - Semantic State Colors

        /// Error/destructive state (keep system red)
        static let error: Color = .red

        /// Success state (keep system green)
        static let success: Color = .green

        /// Warning state (keep system orange)
        static let warning: Color = .orange

        /// Channel/message indicator (orange for visual distinction from AI agents)
        static let channel: Color = .orange

        /// Assistant message background with light/dark mode support
        static var assistantMessageBackground: Color {
            adaptiveColor(
                light: Color(.systemGray6).opacity(0.5),
                dark: Color(.systemGray6).opacity(0.3)
            )
        }
    }

    // MARK: - Spacing

    struct Spacing {
        /// Tight spacing for compact UI
        static let xxxsmall: CGFloat = 2
        static let xxsmall: CGFloat = 4
        static let xsmall: CGFloat = 6
        static let small: CGFloat = 8
        static let medium: CGFloat = 12
        static let large: CGFloat = 16
        static let xlarge: CGFloat = 24
        static let xxlarge: CGFloat = 32

        // MARK: Sidebar Specific
        static let sidebarWidth: CGFloat = 300
        static let sidebarItemVertical: CGFloat = 10
        static let sidebarItemHorizontal: CGFloat = 16
        static let sectionHeaderTop: CGFloat = 12
        static let sectionHeaderBottom: CGFloat = 4
    }

    // MARK: - Typography

    struct Typography {
        /// Apply SF Pro Rounded for softer, friendlier appearance
        static let roundedFont = "SFProRounded"

        /// Letter spacing for subtle refinement
        static let bodyTracking: CGFloat = -0.2
        static let headingTracking: CGFloat = -0.3
        static let captionTracking: CGFloat = 0.0
    }

    // MARK: - Corner Radius

    struct CornerRadius {
        static let small: CGFloat = 4
        static let medium: CGFloat = 6
        static let large: CGFloat = 8
        static let xlarge: CGFloat = 10
        static let avatar: CGFloat = 20
    }

    // MARK: - Icon Sizes

    struct IconSize {
        static let small: CGFloat = 16
        static let medium: CGFloat = 20
        static let large: CGFloat = 24
    }

    // MARK: - Animation

    struct Animation {
        static let quickTransition: SwiftUI.Animation = .easeOut(duration: 0.15)
        static let standardTransition: SwiftUI.Animation = .easeInOut(duration: 0.25)
        static let sidebarSlide: SwiftUI.Animation = .easeInOut(duration: 0.3)
    }
}

// MARK: - Color Helper Functions

/// Create an adaptive color with separate values for light and dark mode
private func adaptiveColor(light: Color, dark: Color) -> Color {
    Color(uiColor: UIColor { traitCollection in
        switch traitCollection.userInterfaceStyle {
        case .dark:
            return UIColor(dark)
        default:
            return UIColor(light)
        }
    })
}
