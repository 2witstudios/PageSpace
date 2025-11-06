//
//  PaginationState.swift
//  PageSpace
//
//  Created by Claude Code on 2025-11-05.
//  Purpose: State management for message pagination
//

import Foundation
import Observation

/// Observable state object managing pagination metadata for message loading
@Observable
final class PaginationState {

    // MARK: - Properties

    /// Cursor for loading older messages (backwards pagination)
    private(set) var cursor: String?

    /// Whether there are more messages to load
    private(set) var hasMore: Bool = true

    /// Whether messages are currently being loaded
    private(set) var isLoadingMore: Bool = false

    /// Number of messages to load per page
    let limit: Int

    /// Error message if pagination failed
    private(set) var error: String?

    // MARK: - Initialization

    init(limit: Int = 50) {
        self.limit = limit
    }

    // MARK: - Public Methods

    /// Update pagination state after loading messages
    func updatePagination(cursor: String?, hasMore: Bool) {
        self.cursor = cursor
        self.hasMore = hasMore
        self.isLoadingMore = false
        self.error = nil
    }

    /// Set loading state
    func setLoading(_ loading: Bool) {
        isLoadingMore = loading
        if loading {
            error = nil
        }
    }

    /// Set error state
    func setError(_ errorMessage: String) {
        error = errorMessage
        isLoadingMore = false
    }

    /// Clear error
    func clearError() {
        error = nil
    }

    /// Reset pagination state (when switching conversations)
    func reset() {
        cursor = nil
        hasMore = true
        isLoadingMore = false
        error = nil
    }

    /// Check if pagination can be triggered
    var canLoadMore: Bool {
        hasMore && !isLoadingMore
    }
}
