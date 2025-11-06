//
//  ConversationState.swift
//  PageSpace
//
//  Created by Claude Code on 2025-11-05.
//  Purpose: State management for conversation metadata and loading states
//

import Foundation
import Observation

/// Observable state object managing conversation metadata
@Observable
final class ConversationState {

    // MARK: - Properties

    /// The ID of the currently active conversation
    private(set) var currentConversationId: String?

    /// The full conversation object with metadata
    private(set) var currentConversation: Conversation?

    /// Whether a conversation is currently being loaded
    private(set) var isLoadingConversation: Bool = false

    /// Error message if conversation loading failed
    private(set) var error: String?

    // MARK: - Initialization

    init(
        currentConversationId: String? = nil,
        currentConversation: Conversation? = nil
    ) {
        self.currentConversationId = currentConversationId
        self.currentConversation = currentConversation
    }

    // MARK: - Public Methods

    /// Set the current conversation
    func setConversation(_ conversation: Conversation) {
        currentConversationId = conversation.id
        currentConversation = conversation
        error = nil
    }

    /// Set the current conversation ID
    func setConversationId(_ id: String?) {
        currentConversationId = id
    }

    /// Update conversation metadata
    func updateConversation(_ conversation: Conversation) {
        guard conversation.id == currentConversationId else { return }
        currentConversation = conversation
    }

    /// Set loading state
    func setLoading(_ loading: Bool) {
        isLoadingConversation = loading
        if loading {
            error = nil
        }
    }

    /// Set error state
    func setError(_ errorMessage: String) {
        error = errorMessage
        isLoadingConversation = false
    }

    /// Clear error
    func clearError() {
        error = nil
    }

    /// Clear all state
    func clear() {
        currentConversationId = nil
        currentConversation = nil
        isLoadingConversation = false
        error = nil
    }

    /// Check if a conversation is active
    var hasActiveConversation: Bool {
        currentConversationId != nil
    }
}
