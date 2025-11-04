import Foundation

enum HTTPMethod: String {
    case GET, POST, PUT, PATCH, DELETE
}

enum APIError: Error, LocalizedError {
    case invalidURL
    case invalidResponse
    case unauthorized
    case forbidden
    case notFound
    case serverError(Int)
    case decodingError(Error)
    case networkError(Error)
    case rateLimitExceeded
    case unknown

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "Invalid URL"
        case .invalidResponse:
            return "Invalid response from server"
        case .unauthorized:
            return "Unauthorized - please log in again"
        case .forbidden:
            return "Access forbidden"
        case .notFound:
            return "Resource not found"
        case .serverError(let code):
            return "Server error (\(code))"
        case .decodingError(let error):
            return "Failed to decode response: \(error.localizedDescription)"
        case .networkError(let error):
            return "Network error: \(error.localizedDescription)"
        case .rateLimitExceeded:
            return "Rate limit exceeded - please upgrade or try again later"
        case .unknown:
            return "An unknown error occurred"
        }
    }
}

class APIClient {
    static let shared = APIClient()

    private let session: URLSession
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder

    // Token refresh management - use actor for thread-safe async access
    private actor TokenRefreshCoordinator {
        private var isRefreshing = false

        func beginRefresh() -> Bool {
            if isRefreshing {
                return false // Already refreshing
            }
            isRefreshing = true
            return true
        }

        func endRefresh() {
            isRefreshing = false
        }

        func isCurrentlyRefreshing() -> Bool {
            return isRefreshing
        }
    }

    private let tokenRefreshCoordinator = TokenRefreshCoordinator()

    private init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 300  // 5 minutes for AI streaming responses
        config.timeoutIntervalForResource = 300 // 5 minutes for streaming
        self.session = URLSession(configuration: config)

        self.decoder = JSONDecoder()
        // Use custom date decoder to handle ISO8601 with and without fractional seconds
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

        let fallbackFormatter = ISO8601DateFormatter()
        fallbackFormatter.formatOptions = [.withInternetDateTime]

        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()

            let dateString = try container.decode(String.self)

            // Try with fractional seconds first (e.g., "2025-11-03T12:34:56.789Z")
            if let date = formatter.date(from: dateString) {
                return date
            }

            // Fallback: try without fractional seconds (e.g., "2025-11-03T12:34:56Z")
            if let date = fallbackFormatter.date(from: dateString) {
                return date
            }

            // If both fail, provide detailed error message
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Invalid date format. Expected ISO8601 format (e.g., '2025-11-03T12:34:56.789Z' or '2025-11-03T12:34:56Z'), but received: '\(dateString)'"
            )
        }

        self.encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
    }

    // MARK: - Generic Request

    func request<T: Decodable>(
        endpoint: String,
        method: HTTPMethod = .GET,
        body: (any Encodable)? = nil,
        queryParams: [String: String]? = nil,
        retryCount: Int = 0
    ) async throws -> T {
        let url = try buildURL(endpoint: endpoint, queryParams: queryParams)
        var request = URLRequest(url: url)
        request.httpMethod = method.rawValue

        // Add authentication headers
        addAuthHeaders(to: &request, method: method)

        // Add body if present
        if let body = body {
            request.httpBody = try encoder.encode(AnyEncodable(body))
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }

        do {
            let (data, response) = try await session.data(for: request)

            guard let httpResponse = response as? HTTPURLResponse else {
                throw APIError.invalidResponse
            }

            try handleHTTPStatus(httpResponse.statusCode)

            // Handle empty responses (204 No Content, DELETE operations, etc.)
            // If the body is empty or we're expecting EmptyResponse, return without decoding
            if data.isEmpty || httpResponse.statusCode == 204 {
                // Check if T is EmptyResponse
                if let emptyResponse = EmptyResponse() as? T {
                    return emptyResponse
                }
            }

            let decoded = try decoder.decode(T.self, from: data)
            return decoded
        } catch APIError.unauthorized {
            // Token might be expired - try to refresh and retry (only once)
            if retryCount == 0 {
                print("⚠️ Got 401 unauthorized - attempting token refresh...")
                if try await refreshTokenIfNeeded() {
                    print("✅ Token refreshed successfully - retrying request...")
                    // Retry the request with new token
                    return try await self.request(
                        endpoint: endpoint,
                        method: method,
                        body: body,
                        queryParams: queryParams,
                        retryCount: 1
                    )
                }
            }
            // If refresh failed or this is a retry, throw the error
            throw APIError.unauthorized
        } catch let error as APIError {
            throw error
        } catch let error as DecodingError {
            throw APIError.decodingError(error)
        } catch {
            throw APIError.networkError(error)
        }
    }

    // MARK: - Streaming Request (SSE)

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

    private func attemptStreamRequest(
        endpoint: String,
        method: HTTPMethod,
        body: (any Encodable)?,
        retryCount: Int,
        continuation: AsyncThrowingStream<SSEEvent, Error>.Continuation
    ) async throws {
        do {
            let url = try buildURL(endpoint: endpoint)
            var request = URLRequest(url: url)
            request.httpMethod = method.rawValue
            request.setValue("text/event-stream", forHTTPHeaderField: "Accept")

            // Add authentication
            addAuthHeaders(to: &request, method: method)

            // Add body
            if let body = body {
                request.httpBody = try encoder.encode(AnyEncodable(body))
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            }

            let (bytes, response) = try await session.bytes(for: request)

            guard let httpResponse = response as? HTTPURLResponse else {
                throw APIError.invalidResponse
            }

            try handleHTTPStatus(httpResponse.statusCode)

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
            // Token might be expired - try to refresh and retry (only once)
            if retryCount == 0 {
                print("⚠️ Stream got 401 unauthorized - attempting token refresh...")
                if try await refreshTokenIfNeeded() {
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

    // MARK: - Helper Methods

    private func buildURL(endpoint: String, queryParams: [String: String]? = nil) throws -> URL {
        guard var url = URL(string: endpoint, relativeTo: AppEnvironment.apiBaseURL) else {
            throw APIError.invalidURL
        }

        if let queryParams = queryParams, !queryParams.isEmpty {
            var components = URLComponents(url: url, resolvingAgainstBaseURL: true)
            components?.queryItems = queryParams.map { URLQueryItem(name: $0.key, value: $0.value) }
            guard let finalURL = components?.url else {
                throw APIError.invalidURL
            }
            url = finalURL
        }

        return url
    }

    private func addAuthHeaders(to request: inout URLRequest, method: HTTPMethod) {
        // Add JWT token
        if let token = AuthManager.shared.getToken() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        // Add CSRF token for all authenticated requests (backend requires it for GET too)
        if let csrfToken = AuthManager.shared.getCSRFToken() {
            request.setValue(csrfToken, forHTTPHeaderField: "X-CSRF-Token")
        }
    }

    // MARK: - Token Refresh

    private func refreshTokenIfNeeded() async throws -> Bool {
        // Check if another request is already refreshing using actor
        if await tokenRefreshCoordinator.isCurrentlyRefreshing() {
            // Wait a bit for the other refresh to complete
            try await Task.sleep(nanoseconds: 500_000_000) // 0.5 seconds
            // Return true if token is now available (refresh succeeded)
            return AuthManager.shared.getToken() != nil
        }

        // Try to begin refresh (returns false if already refreshing)
        guard await tokenRefreshCoordinator.beginRefresh() else {
            // Another task started refreshing between check and begin
            try await Task.sleep(nanoseconds: 500_000_000)
            return AuthManager.shared.getToken() != nil
        }

        defer {
            Task {
                await tokenRefreshCoordinator.endRefresh()
            }
        }

        do {
            // Attempt to refresh the token (returns Void, throws on error)
            try await AuthManager.shared.refreshToken()

            // Check if we now have a valid token
            if AuthManager.shared.getToken() != nil {
                print("✅ Token refresh successful")
                return true
            } else {
                print("❌ Token refresh failed - no token after refresh")
                await MainActor.run {
                    AuthManager.shared.logout()
                }
                return false
            }
        } catch {
            print("❌ Token refresh error: \(error.localizedDescription)")
            // Clear tokens on error
            await MainActor.run {
                AuthManager.shared.logout()
            }
            return false
        }
    }

    private func handleHTTPStatus(_ statusCode: Int) throws {
        switch statusCode {
        case 200...299:
            return
        case 401:
            throw APIError.unauthorized
        case 403:
            throw APIError.forbidden
        case 404:
            throw APIError.notFound
        case 429:
            throw APIError.rateLimitExceeded
        case 500...599:
            throw APIError.serverError(statusCode)
        default:
            throw APIError.unknown
        }
    }

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

// MARK: - Type-erased Encodable wrapper

struct AnyEncodable: Encodable {
    private let _encode: (Encoder) throws -> Void

    init<T: Encodable>(_ value: T) {
        _encode = { encoder in
            try value.encode(to: encoder)
        }
    }

    func encode(to encoder: Encoder) throws {
        try _encode(encoder)
    }
}
