import Foundation

/// Legacy facade for API requests - delegates to specialized components
/// This maintains backward compatibility while the new architecture is being adopted
///
/// New code should use:
/// - HTTPClient.shared for standard HTTP requests
/// - SSEStreamHandler.shared for streaming requests
/// - TokenRefreshCoordinator.shared for token management
class APIClient {
    static let shared = APIClient()

    private init() {}

    // MARK: - HTTP Requests (delegates to HTTPClient)

    func request<T: Decodable>(
        endpoint: String,
        method: HTTPMethod = .GET,
        body: (any Encodable)? = nil,
        queryParams: [String: String]? = nil,
        retryCount: Int = 0
    ) async throws -> T {
        return try await HTTPClient.shared.request(
            endpoint: endpoint,
            method: method,
            body: body,
            queryParams: queryParams,
            retryCount: retryCount
        )
    }

    // MARK: - Streaming Requests (delegates to SSEStreamHandler)

    func streamRequest(
        endpoint: String,
        method: HTTPMethod = .POST,
        body: (any Encodable)? = nil,
        retryCount: Int = 0
    ) -> AsyncThrowingStream<SSEEvent, Error> {
        return SSEStreamHandler.shared.streamRequest(
            endpoint: endpoint,
            method: method,
            body: body,
            retryCount: retryCount
        )
    }
}
