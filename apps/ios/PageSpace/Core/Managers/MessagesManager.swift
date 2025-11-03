import Foundation
import Combine

@MainActor
class MessagesManager: ObservableObject {
    static let shared = MessagesManager()

    @Published var threads: [MessageThread] = []
    @Published var isLoading = false
    @Published var searchQuery = ""
    @Published var error: Error?

    private let dmService = DirectMessagesService()
    private let channelService = ChannelService()
    private let realtimeService = RealtimeService.shared
    private let authManager = AuthManager.shared

    private var cancellables = Set<AnyCancellable>()

    private init() {
        setupRealtimeSubscriptions()
    }

    // MARK: - Computed Properties

    /// Filter threads by search query
    var filteredThreads: [MessageThread] {
        threads.filtered(by: searchQuery)
    }

    /// Total unread count (DMs only)
    var totalUnreadCount: Int {
        threads.totalUnreadCount
    }

    /// Current user ID
    private var currentUserId: String {
        authManager.currentUser?.id ?? ""
    }

    // MARK: - Load All Threads

    /// Load both DM conversations and channels, then merge into unified thread list
    func loadAllThreads() async throws {
        isLoading = true
        error = nil
        defer { isLoading = false }

        // Check if task is cancelled before starting
        guard !Task.isCancelled else {
            print("⚠️ MessagesManager: Load cancelled before starting")
            return
        }

        // Fetch DMs and channels in parallel with graceful failure
        async let dmResult = fetchDMsWithErrorHandling()
        async let channelResult = fetchChannelsWithErrorHandling()

        let (dmConversations, channelList) = await (dmResult, channelResult)

        // Check again before processing results
        guard !Task.isCancelled else {
            print("⚠️ MessagesManager: Load cancelled after fetching")
            return
        }

        // Convert to MessageThread models
        let dmThreads = dmConversations.map { conversation in
            MessageThread.from(conversation: conversation, currentUserId: currentUserId)
        }

        let channelThreads = channelList.map { channel in
            MessageThread.from(channel: channel)
        }

        // Merge and sort by most recent
        threads = (dmThreads + channelThreads).sorted(by: MessageThread.sortByRecent)

        print("✅ MessagesManager: Loaded \(dmThreads.count) DMs + \(channelThreads.count) channels = \(threads.count) total threads")
    }

    /// Fetch DMs with error handling (returns empty array on failure)
    private func fetchDMsWithErrorHandling() async -> [DMConversation] {
        do {
            return try await dmService.fetchConversations(refresh: true)
        } catch {
            if Task.isCancelled {
                print("⚠️ MessagesManager: DM fetch cancelled")
            } else {
                print("❌ MessagesManager: DM fetch failed: \(error)")
            }
            return []
        }
    }

    /// Fetch channels with error handling (returns empty array on failure)
    private func fetchChannelsWithErrorHandling() async -> [Channel] {
        do {
            return try await channelService.fetchAllChannels()
        } catch {
            if Task.isCancelled {
                print("⚠️ MessagesManager: Channel fetch cancelled")
            } else {
                print("❌ MessagesManager: Channel fetch failed: \(error)")
            }
            return []
        }
    }

    /// Refresh threads (pull-to-refresh)
    func refreshThreads() async {
        do {
            try await loadAllThreads()
        } catch {
            print("❌ MessagesManager: Refresh failed: \(error)")
        }
    }

    // MARK: - Real-time Updates

    private func setupRealtimeSubscriptions() {
        // Subscribe to DM message events
        realtimeService.dmMessageReceived
            .sink { [weak self] message in
                self?.handleNewDMMessage(message)
            }
            .store(in: &cancellables)

        // Subscribe to channel message events
        realtimeService.channelMessageReceived
            .sink { [weak self] message in
                self?.handleNewChannelMessage(message)
            }
            .store(in: &cancellables)
    }

    private func handleNewDMMessage(_ message: DirectMessage) {
        // Update the DM service's state
        dmService.handleNewMessage(message)

        // Update thread preview
        if let threadIndex = threads.firstIndex(where: { $0.id == message.conversationId }) {
            let updatedThread = threads[threadIndex]

            // Create updated thread with new message preview
            let newThread = MessageThread(
                id: updatedThread.id,
                type: updatedThread.type,
                title: updatedThread.title,
                subtitle: updatedThread.subtitle,
                lastMessage: message.content,
                lastMessageAt: message.createdAt,
                unreadCount: (updatedThread.unreadCount ?? 0) + 1, // Increment unread
                avatarUrl: updatedThread.avatarUrl,
                otherUserId: updatedThread.otherUserId,
                otherUser: updatedThread.otherUser,
                pageId: updatedThread.pageId,
                driveId: updatedThread.driveId,
                driveName: updatedThread.driveName
            )

            // Replace and move to top
            threads.remove(at: threadIndex)
            threads.insert(newThread, at: 0)
        }
    }

    private func handleNewChannelMessage(_ message: ChannelMessage) {
        // Update the channel service's state
        channelService.handleNewMessage(message)

        // Update thread preview
        if let threadIndex = threads.firstIndex(where: { $0.pageId == message.pageId }) {
            let updatedThread = threads[threadIndex]

            // Create updated thread with new message preview
            let newThread = MessageThread(
                id: updatedThread.id,
                type: updatedThread.type,
                title: updatedThread.title,
                subtitle: updatedThread.subtitle,
                lastMessage: message.content,
                lastMessageAt: message.createdAt,
                unreadCount: nil, // Channels don't track unread
                avatarUrl: updatedThread.avatarUrl,
                otherUserId: updatedThread.otherUserId,
                otherUser: updatedThread.otherUser,
                pageId: updatedThread.pageId,
                driveId: updatedThread.driveId,
                driveName: updatedThread.driveName
            )

            // Replace and move to top
            threads.remove(at: threadIndex)
            threads.insert(newThread, at: 0)
        }
    }

    // MARK: - Thread Helpers

    /// Get a thread by ID
    func getThread(id: String) -> MessageThread? {
        return threads.first { $0.id == id }
    }

    /// Mark a DM thread as read
    func markThreadAsRead(_ thread: MessageThread) async {
        guard thread.type == .dm else { return }

        do {
            try await dmService.markAsRead(conversationId: thread.id)

            // Update local thread
            if let index = threads.firstIndex(where: { $0.id == thread.id }) {
                let updatedThread = threads[index]
                threads[index] = MessageThread(
                    id: updatedThread.id,
                    type: updatedThread.type,
                    title: updatedThread.title,
                    subtitle: updatedThread.subtitle,
                    lastMessage: updatedThread.lastMessage,
                    lastMessageAt: updatedThread.lastMessageAt,
                    unreadCount: 0, // Mark as read
                    avatarUrl: updatedThread.avatarUrl,
                    otherUserId: updatedThread.otherUserId,
                    otherUser: updatedThread.otherUser,
                    pageId: updatedThread.pageId,
                    driveId: updatedThread.driveId,
                    driveName: updatedThread.driveName
                )
            }
        } catch {
            print("❌ MessagesManager: Failed to mark thread as read: \(error)")
        }
    }

    // MARK: - Service Access

    /// Access the DM service directly (for conversation views)
    var directMessagesService: DirectMessagesService {
        return dmService
    }

    /// Access the channel service directly (for channel views)
    var channelMessagingService: ChannelService {
        return channelService
    }
}
