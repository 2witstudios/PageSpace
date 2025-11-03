import Foundation

@MainActor
class ChannelService: ObservableObject {
    private let apiClient = APIClient.shared

    @Published var channels: [Channel] = []
    @Published var currentMessages: [ChannelMessage] = []
    @Published var isLoadingChannels = false
    @Published var isLoadingMessages = false
    @Published var isSending = false

    // MARK: - Fetch All Channels

    /// Fetch all channels from all drives the user has access to
    func fetchAllChannels() async throws -> [Channel] {
        isLoadingChannels = true
        defer { isLoadingChannels = false }

        // Fetch all drives
        let drives: [Drive] = try await apiClient.request(
            endpoint: "/api/drives",
            method: .GET
        )

        guard !drives.isEmpty else {
            print("⚠️ ChannelService: No drives available")
            channels = []
            return []
        }

        var allChannels: [Channel] = []

        // Fetch pages from each drive and filter for channels
        for drive in drives {
            do {
                let pages: [Page] = try await apiClient.request(
                    endpoint: "/api/drives/\(drive.id)/pages",
                    method: .GET
                )

                // Filter for CHANNEL type pages
                let channelPages = pages.filter { $0.type == .channel }

                // Convert to Channel model
                let driveChannels = channelPages.map { page in
                    Channel.from(page: page, drive: drive)
                }

                allChannels.append(contentsOf: driveChannels)
            } catch {
                print("❌ ChannelService: Failed to fetch pages for drive \(drive.id): \(error)")
                // Continue with other drives even if one fails
            }
        }

        channels = allChannels
        print("✅ ChannelService: Fetched \(allChannels.count) channels from \(drives.count) drives")
        return allChannels
    }

    /// Get a specific channel by ID
    func getChannel(pageId: String) -> Channel? {
        return channels.first { $0.pageId == pageId }
    }

    // MARK: - Fetch Messages

    /// Fetch messages for a specific channel
    func fetchMessages(pageId: String) async throws -> [ChannelMessage] {
        isLoadingMessages = true
        defer { isLoadingMessages = false }

        do {
            let messages: [ChannelMessage] = try await apiClient.request(
                endpoint: "/api/channels/\(pageId)/messages",
                method: .GET
            )

            currentMessages = messages
            print("✅ ChannelService: Fetched \(messages.count) messages for channel \(pageId)")
            return messages
        } catch {
            print("❌ ChannelService: Failed to fetch messages: \(error)")
            throw error
        }
    }

    // MARK: - Send Message

    /// Send a message in a channel
    func sendMessage(pageId: String, content: String) async throws -> ChannelMessage {
        isSending = true
        defer { isSending = false }

        let request = SendChannelMessageRequest(content: content)

        do {
            let message: ChannelMessage = try await apiClient.request(
                endpoint: "/api/channels/\(pageId)/messages",
                method: .POST,
                body: request
            )

            // Add to current messages if this is the active channel
            if !currentMessages.isEmpty && currentMessages.first?.pageId == pageId {
                currentMessages.append(message)
            }

            print("✅ ChannelService: Sent message in channel \(pageId)")
            return message
        } catch {
            print("❌ ChannelService: Failed to send message: \(error)")
            throw error
        }
    }

    // MARK: - Optimistic Updates

    /// Add a temporary message optimistically (before server confirmation)
    func addOptimisticMessage(pageId: String, content: String, userId: String, userName: String) -> ChannelMessage {
        let tempMessage = ChannelMessage(
            id: "temp-\(Date().timeIntervalSince1970)",
            pageId: pageId,
            userId: userId,
            content: content,
            createdAt: Date(),
            user: ChannelUser(name: userName, image: nil)
        )

        currentMessages.append(tempMessage)
        return tempMessage
    }

    /// Replace temporary message with real message from server
    func replaceOptimisticMessage(tempId: String, with realMessage: ChannelMessage) {
        if let index = currentMessages.firstIndex(where: { $0.id == tempId }) {
            currentMessages[index] = realMessage
        }
    }

    /// Remove a temporary message (if send failed)
    func removeOptimisticMessage(tempId: String) {
        currentMessages.removeAll { $0.id == tempId }
    }

    // MARK: - Real-time Updates

    /// Handle a new message received via Socket.IO
    func handleNewMessage(_ message: ChannelMessage) {
        // Don't add if it's a duplicate (already added optimistically)
        guard !currentMessages.contains(where: { $0.id == message.id }) else {
            return
        }

        // Add to messages if it belongs to the current channel
        if !currentMessages.isEmpty && currentMessages.first?.pageId == message.pageId {
            currentMessages.append(message)
        }

        print("📨 ChannelService: Received new message in channel \(message.pageId)")
    }

    // MARK: - Helpers

    /// Clear current messages (when leaving a channel)
    func clearCurrentMessages() {
        currentMessages.removeAll()
    }

    /// Refresh channels (useful after real-time updates)
    func refreshChannels() async {
        do {
            _ = try await fetchAllChannels()
        } catch {
            print("❌ ChannelService: Failed to refresh channels: \(error)")
        }
    }
}
