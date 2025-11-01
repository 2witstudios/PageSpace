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

    private init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 300 // 5 minutes for streaming
        self.session = URLSession(configuration: config)

        self.decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601

        self.encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
    }

    // MARK: - Generic Request

    func request<T: Decodable>(
        endpoint: String,
        method: HTTPMethod = .GET,
        body: (any Encodable)? = nil,
        queryParams: [String: String]? = nil
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
        body: (any Encodable)? = nil
    ) -> AsyncThrowingStream<SSEEvent, Error> {
        AsyncThrowingStream { continuation in
            Task {
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
                        continuation.finish(throwing: APIError.invalidResponse)
                        return
                    }

                    try handleHTTPStatus(httpResponse.statusCode)

                    // Parse SSE stream
                    var buffer = ""
                    for try await byte in bytes {
                        let char = Character(UnicodeScalar(byte))
                        buffer.append(char)

                        // SSE messages end with double newline
                        if buffer.hasSuffix("\n\n") {
                            let event = parseSSEEvent(buffer)
                            if let event = event {
                                continuation.yield(event)
                            }
                            buffer = ""
                        }
                    }

                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
        }
    }

    // MARK: - Helper Methods

    private func buildURL(endpoint: String, queryParams: [String: String]? = nil) throws -> URL {
        guard var url = URL(string: endpoint, relativeTo: Environment.apiBaseURL) else {
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

        // Add CSRF token for write operations
        if method != .GET, let csrfToken = AuthManager.shared.getCSRFToken() {
            request.setValue(csrfToken, forHTTPHeaderField: "X-CSRF-Token")
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
