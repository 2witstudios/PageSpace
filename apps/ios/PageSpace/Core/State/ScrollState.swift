//
//  ScrollState.swift
//  PageSpace
//
//  Created by Claude Code on 2025-11-05.
//  Purpose: State management for scroll position and auto-scroll behavior
//

import Foundation
import Observation

/// Observable state object managing scroll position and auto-scroll behavior
@Observable
final class ScrollState {

    // MARK: - Properties

    /// Whether auto-scroll should be enabled
    private(set) var shouldAutoScroll: Bool = true

    /// Whether the scroll position is near the bottom (within threshold)
    private(set) var isNearBottom: Bool = true

    /// Whether scroll updates should be suppressed (during rapid updates)
    private(set) var scrollSuppressed: Bool = false

    /// Message ID to anchor scroll position during pagination
    /// When set, scroll will restore to this message after prepending older messages
    private(set) var paginationAnchorId: String?

    /// Threshold in points for considering "near bottom"
    let bottomThreshold: CGFloat

    /// Whether the scroll-to-bottom button should be visible
    var showScrollButton: Bool {
        !isNearBottom
    }

    // MARK: - Initialization

    init(bottomThreshold: CGFloat = 100.0) {
        self.bottomThreshold = bottomThreshold
    }

    // MARK: - Public Methods

    /// Update scroll position tracking
    /// - Parameters:
    ///   - contentHeight: Total height of scroll content
    ///   - visibleHeight: Height of visible scroll area
    ///   - offset: Current scroll offset from top
    func updateScrollPosition(contentHeight: CGFloat, visibleHeight: CGFloat, offset: CGFloat) {
        // Calculate distance from bottom
        let distanceFromBottom = contentHeight - (offset + visibleHeight)

        // Update near-bottom state
        let wasNearBottom = isNearBottom
        isNearBottom = distanceFromBottom <= bottomThreshold

        // If user scrolled up manually, disable auto-scroll
        if !isNearBottom && wasNearBottom {
            shouldAutoScroll = false
        }

        // If user scrolled back to bottom, re-enable auto-scroll
        if isNearBottom && !wasNearBottom {
            shouldAutoScroll = true
        }
    }

    /// Enable auto-scroll (e.g., when sending a message)
    func enableAutoScroll() {
        shouldAutoScroll = true
        isNearBottom = true
    }

    /// Disable auto-scroll (e.g., when user manually scrolls up)
    func disableAutoScroll() {
        shouldAutoScroll = false
    }

    /// Set scroll suppression state (during rapid updates)
    func setScrollSuppressed(_ suppressed: Bool) {
        scrollSuppressed = suppressed
    }

    /// Request scroll to bottom (for button tap)
    /// Returns true if scroll should occur
    func requestScrollToBottom() -> Bool {
        enableAutoScroll()
        return true
    }

    /// Reset scroll state (when switching conversations)
    func reset() {
        shouldAutoScroll = true
        isNearBottom = true
        scrollSuppressed = false
        paginationAnchorId = nil
    }

    /// Set pagination anchor to preserve scroll position when loading older messages
    /// Call this before prepending older messages to the array
    func setPaginationAnchor(_ id: String?) {
        paginationAnchorId = id
    }

    /// Clear pagination anchor after scroll position has been restored
    func clearPaginationAnchor() {
        paginationAnchorId = nil
    }

    /// Check if auto-scroll should occur for new content
    var shouldScrollOnNewContent: Bool {
        shouldAutoScroll && !scrollSuppressed
    }
}
