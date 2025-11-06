import Foundation
import Combine
import SocketIO

@MainActor
class RealtimeService: ObservableObject {
    static let shared = RealtimeService()

    @Published var isConnected = false
    @Published var typingUsers: [String: String] = [:] // userId: userName

    private var manager: SocketManager?
    private var socket: SocketIOClient?

    // MARK: - Combine Publishers for Message Events

    let dmMessageReceived = PassthroughSubject<DirectMessage, Never>()
    let channelMessageReceived = PassthroughSubject<ChannelMessage, Never>()

    private init() {}

    // MARK: - Connection Management

    func connect() {
        guard let token = AuthManager.shared.getToken() else {
            print("❌ RealtimeService: Cannot connect - no auth token")
            return
        }

        // Validate token before connecting
        if AuthManager.shared.isTokenExpired(token) {
            print("❌ RealtimeService: Cannot connect - token expired")
            print("🔄 Attempting to refresh token first...")
            Task {
                do {
                    try await AuthManager.shared.refreshToken()
                    // Retry connection with fresh token
                    await MainActor.run {
                        print("✅ Token refreshed - retrying Socket.IO connection")
                        connect()
                    }
                } catch {
                    print("❌ Failed to refresh token for Socket.IO: \(error)")
                }
            }
            return
        }

        guard manager == nil else {
            print("⚠️ RealtimeService: Already connected or connecting")
            return
        }

        let realtimeURL = AppEnvironment.realtimeURL

        print("🔌 RealtimeService: Connecting to \(realtimeURL.absoluteString)")

        manager = SocketManager(
            socketURL: realtimeURL,
            config: [
                .log(false),
                .compress,
                .forceWebsockets(true),
                .reconnects(true),
                .reconnectAttempts(-1), // Infinite reconnection attempts
                .reconnectWait(1), // Start with 1 second
                .reconnectWaitMax(5) // Max 5 seconds between attempts
            ]
        )

        socket = manager?.defaultSocket

        setupEventHandlers()

        // Pass auth token via payload (withPayload auto-wraps as socket.handshake.auth)
        socket?.connect(withPayload: ["token": token])
    }

    func disconnect() {
        print("🔌 RealtimeService: Disconnecting")
        socket?.disconnect()
        manager = nil
        socket = nil
        isConnected = false
        typingUsers.removeAll()
    }

    private func setupEventHandlers() {
        // MARK: - Connection Events

        socket?.on(clientEvent: .connect) { [weak self] _, _ in
            Task { @MainActor in
                self?.isConnected = true
                print("✅ RealtimeService: Connected to Socket.IO")
            }
        }

        socket?.on(clientEvent: .disconnect) { [weak self] data, _ in
            Task { @MainActor in
                self?.isConnected = false
                print("❌ RealtimeService: Disconnected from Socket.IO")
                if let reason = data.first as? String {
                    print("   Reason: \(reason)")
                }
            }
        }

        socket?.on(clientEvent: .error) { data, _ in
            print("❌ RealtimeService: Socket error")
            if let error = data.first {
                print("   Error: \(error)")
            }
        }

        socket?.on(clientEvent: .reconnect) { data, _ in
            print("🔄 RealtimeService: Reconnecting...")
            if let attemptNumber = data.first as? Int {
                print("   Attempt: \(attemptNumber)")
            }
        }

        socket?.on(clientEvent: .reconnectAttempt) { data, _ in
            print("🔄 RealtimeService: Reconnection attempt")
            if let attemptNumber = data.first as? Int {
                print("   Attempt: \(attemptNumber)")
            }
        }

        // MARK: - DM Events

        socket?.on("new_dm_message") { [weak self] data, _ in
            guard let self = self else { return }
            print("📨 RealtimeService: Received new_dm_message event")

            guard let dict = data.first as? [String: Any] else {
                print("❌ Failed to parse new_dm_message data")
                return
            }

            do {
                let jsonData = try JSONSerialization.data(withJSONObject: dict)
                let decoder = JSONDecoder()
                decoder.dateDecodingStrategy = .customISO8601
                let message = try decoder.decode(DirectMessage.self, from: jsonData)

                Task { @MainActor in
                    self.dmMessageReceived.send(message)
                }
            } catch {
                print("❌ Failed to decode DirectMessage: \(error)")
            }
        }

        // MARK: - Channel Events

        socket?.on("new_message") { [weak self] data, _ in
            guard let self = self else { return }
            print("📨 RealtimeService: Received new_message event (channel)")

            guard let dict = data.first as? [String: Any] else {
                print("❌ Failed to parse new_message data")
                return
            }

            do {
                let jsonData = try JSONSerialization.data(withJSONObject: dict)
                let decoder = JSONDecoder()
                decoder.dateDecodingStrategy = .customISO8601
                let message = try decoder.decode(ChannelMessage.self, from: jsonData)

                Task { @MainActor in
                    self.channelMessageReceived.send(message)
                }
            } catch {
                print("❌ Failed to decode ChannelMessage: \(error)")
            }
        }

        // MARK: - Typing Indicators

        socket?.on("typing") { [weak self] data, _ in
            guard let dict = data.first as? [String: Any],
                  let userId = dict["userId"] as? String,
                  let userName = dict["userName"] as? String else {
                print("❌ Failed to parse typing event")
                return
            }

            Task { @MainActor in
                self?.typingUsers[userId] = userName
                print("⌨️ \(userName) is typing...")
            }
        }

        socket?.on("stop_typing") { [weak self] data, _ in
            guard let dict = data.first as? [String: Any],
                  let userId = dict["userId"] as? String else {
                print("❌ Failed to parse stop_typing event")
                return
            }

            Task { @MainActor in
                self?.typingUsers.removeValue(forKey: userId)
            }
        }
    }

    // MARK: - Room Management

    func joinDMConversation(_ conversationId: String) {
        guard isConnected else {
            print("⚠️ RealtimeService: Cannot join DM - not connected")
            return
        }
        print("🚪 RealtimeService: Joining DM conversation: \(conversationId)")
        socket?.emit("join_dm_conversation", conversationId)
    }

    func leaveDMConversation(_ conversationId: String) {
        guard isConnected else { return }
        print("🚪 RealtimeService: Leaving DM conversation: \(conversationId)")
        socket?.emit("leave_dm_conversation", conversationId)
    }

    func joinChannel(_ pageId: String) {
        guard isConnected else {
            print("⚠️ RealtimeService: Cannot join channel - not connected")
            return
        }
        print("🚪 RealtimeService: Joining channel: \(pageId)")
        socket?.emit("join_channel", pageId)
    }

    func leaveChannel(_ pageId: String) {
        guard isConnected else { return }
        print("🚪 RealtimeService: Leaving channel: \(pageId)")
        socket?.emit("leave_channel", pageId)
    }

    // MARK: - Typing Indicators

    func sendTyping(in roomId: String, type: MessageThreadType) {
        guard isConnected else { return }

        switch type {
        case .dm:
            socket?.emit("typing", ["conversationId": roomId])
        case .channel:
            socket?.emit("typing", ["channelId": roomId])
        }
    }

    func sendStopTyping(in roomId: String, type: MessageThreadType) {
        guard isConnected else { return }

        switch type {
        case .dm:
            socket?.emit("stop_typing", ["conversationId": roomId])
        case .channel:
            socket?.emit("stop_typing", ["channelId": roomId])
        }
    }
}

// MARK: - Custom ISO8601 Date Decoding

extension JSONDecoder.DateDecodingStrategy {
    static var customISO8601: JSONDecoder.DateDecodingStrategy {
        return .custom { decoder in
            let container = try decoder.singleValueContainer()
            let dateString = try container.decode(String.self)

            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

            if let date = formatter.date(from: dateString) {
                return date
            }

            // Fallback without fractional seconds
            formatter.formatOptions = [.withInternetDateTime]
            if let date = formatter.date(from: dateString) {
                return date
            }

            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Cannot decode date string \(dateString)"
            )
        }
    }
}
