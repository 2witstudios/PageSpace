import Foundation

/// Server-Sent Events (SSE) stream handler
/// Manages long-lived streaming connections for real-time AI responses
class SSEStreamHandler {
    static let shared = SSEStreamHandler()

    private init() {}

    // MARK: - Public Interface

    /// Create a streaming request that yields SSE events as they arrive
    func streamRequest(
        endpoint: String,
        method: HTTPMethod = .POST,
        body: (any Encodable)? = nil,
        retryCount: Int = 0
    ) -> AsyncThrowingStream<SSEEvent, Error> {
        AsyncThrowingStream { continuation in
            Task {
                do {
                    try await attemptStreamRequest(
                        endpoint: endpoint,
                        method: method,
                        body: body,
                        retryCount: retryCount,
                        continuation: continuation
                    )
                } catch {
                    continuation.finish(throwing: error)
                }
            }
        }
    }

    // MARK: - Private Implementation

    private func attemptStreamRequest(
        endpoint: String,
        method: HTTPMethod,
        body: (any Encodable)?,
        retryCount: Int,
        continuation: AsyncThrowingStream<SSEEvent, Error>.Continuation
    ) async throws {
        do {
            let url = try HTTPClient.shared.buildURL(endpoint: endpoint)
            var request = URLRequest(url: url)
            request.httpMethod = method.rawValue
            request.setValue("text/event-stream", forHTTPHeaderField: "Accept")

            // Add authentication
            HTTPClient.shared.addAuthHeaders(to: &request, method: method)

            // Add body
            if let body = body {
                request.httpBody = try HTTPClient.shared.jsonEncoder.encode(AnyEncodable(body))
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            }

            let (bytes, response) = try await HTTPClient.shared.urlSession.bytes(for: request)

            guard let httpResponse = response as? HTTPURLResponse else {
                throw APIError.invalidResponse
            }

            try HTTPClient.shared.handleHTTPStatus(httpResponse.statusCode)

            // Parse SSE stream with proper UTF-8 handling
            var byteBuffer = Data()  // Accumulate bytes for UTF-8 decoding
            var eventBuffer = ""     // Decoded UTF-8 string buffer

            for try await byte in bytes {
                byteBuffer.append(byte)

                // Try to decode accumulated bytes as UTF-8
                if let decodedString = String(data: byteBuffer, encoding: .utf8) {
                    // Successfully decoded - append to event buffer
                    eventBuffer.append(decodedString)
                    byteBuffer.removeAll()  // Clear decoded bytes

                    // SSE messages end with double newline
                    if eventBuffer.hasSuffix("\n\n") {
                        let event = parseSSEEvent(eventBuffer)
                        if let event = event {
                            continuation.yield(event)
                        }
                        eventBuffer = ""
                    }
                }
                // If decoding fails, keep accumulating bytes (incomplete multi-byte UTF-8 sequence)
            }

            continuation.finish()
        } catch APIError.unauthorized {
            // Prevent deadlock: Don't attempt refresh if this IS the refresh endpoint
            // The refresh endpoint returning 401 means the refresh token itself is invalid
            if endpoint == APIEndpoints.refresh {
                print("❌ Refresh endpoint returned 401 - refresh token is invalid")
                throw APIError.unauthorized
            }

            // Token might be expired - try to refresh and retry (only once)
            if retryCount == 0 {
                print("⚠️ Stream got 401 unauthorized - attempting token refresh...")
                if try await TokenRefreshCoordinator.shared.refreshTokenIfNeeded() {
                    print("✅ Token refreshed - retrying stream request...")
                    // Retry the stream request with new token
                    try await attemptStreamRequest(
                        endpoint: endpoint,
                        method: method,
                        body: body,
                        retryCount: 1,
                        continuation: continuation
                    )
                    return
                }
            }
            // If refresh failed or this is a retry, throw the error
            throw APIError.unauthorized
        }
    }

    // MARK: - SSE Parsing

    private func parseSSEEvent(_ rawEvent: String) -> SSEEvent? {
        var eventType = "message"
        var data = ""

        let lines = rawEvent.split(separator: "\n")
        for line in lines {
            if line.hasPrefix("event:") {
                eventType = String(line.dropFirst(6).trimmingCharacters(in: .whitespaces))
            } else if line.hasPrefix("data:") {
                data = String(line.dropFirst(5).trimmingCharacters(in: .whitespaces))
            }
        }

        guard !data.isEmpty else { return nil }

        return SSEEvent(event: eventType, data: data)
    }
}

// MARK: - SSE Event Model

struct SSEEvent {
    let event: String
    let data: String
}
