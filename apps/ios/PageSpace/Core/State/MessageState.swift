//
//  MessageState.swift
//  PageSpace
//
//  Created by Claude Code on 2025-11-05.
//  Purpose: Isolated state management for completed messages array
//  Prevents full view rebuilds when streaming updates occur
//

import Foundation
import Observation

/// Observable state object managing the completed messages array
/// Separated from streaming state to prevent unnecessary view rebuilds
@Observable
final class MessageState {

    // MARK: - Properties

    /// Array of completed messages in the current conversation
    private(set) var messages: [Message] = []

    // MARK: - Initialization

    init(messages: [Message] = []) {
        self.messages = messages
    }

    // MARK: - Public Methods

    /// Replace all messages (used when loading a new conversation)
    func setMessages(_ newMessages: [Message]) {
        messages = newMessages
    }

    /// Append a new message to the end of the array
    func append(_ message: Message) {
        messages.append(message)
    }

    /// Prepend messages to the beginning (used for pagination)
    func prepend(_ newMessages: [Message]) {
        messages = newMessages + messages
    }

    /// Update an existing message
    func update(_ message: Message) {
        if let index = messages.firstIndex(where: { $0.id == message.id }) {
            messages[index] = message
        }
    }

    /// Delete a message by ID
    func delete(id: String) {
        messages.removeAll { $0.id == id }
    }

    /// Delete multiple messages by IDs
    func deleteMultiple(ids: Set<String>) {
        messages.removeAll { ids.contains($0.id) }
    }

    /// Clear all messages
    func clear() {
        messages = []
    }

    /// Get a message by ID
    func getMessage(id: String) -> Message? {
        messages.first { $0.id == id }
    }

    /// Get the last message
    var lastMessage: Message? {
        messages.last
    }

    /// Count of messages
    var count: Int {
        messages.count
    }

    /// Check if messages array is empty
    var isEmpty: Bool {
        messages.isEmpty
    }
}
