import Foundation

/// HTTP client responsible for standard HTTP requests (GET, POST, PATCH, DELETE)
/// Handles authentication headers, JSON encoding/decoding, and error handling
class HTTPClient {
    static let shared = HTTPClient()

    private let session: URLSession
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder

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

    // MARK: - Public Interface

    /// Perform a generic HTTP request with automatic JSON encoding/decoding
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
            // Prevent deadlock: Don't attempt refresh if this IS the refresh endpoint
            // The refresh endpoint returning 401 means the refresh token itself is invalid
            if endpoint == APIEndpoints.refresh {
                print("❌ Refresh endpoint returned 401 - refresh token is invalid")
                throw APIError.unauthorized
            }

            // Token might be expired - try to refresh and retry (only once)
            if retryCount == 0 {
                print("⚠️ Got 401 unauthorized - attempting token refresh...")
                if try await TokenRefreshCoordinator.shared.refreshTokenIfNeeded() {
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

    // MARK: - Internal Helpers

    func buildURL(endpoint: String, queryParams: [String: String]? = nil) throws -> URL {
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

    func addAuthHeaders(to request: inout URLRequest, method: HTTPMethod) {
        // Add JWT token
        if let token = AuthManager.shared.getToken() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        // Add CSRF token for all authenticated requests (backend requires it for GET too)
        if let csrfToken = AuthManager.shared.getCSRFToken() {
            request.setValue(csrfToken, forHTTPHeaderField: "X-CSRF-Token")
        }
    }

    func handleHTTPStatus(_ statusCode: Int) throws {
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

    // Expose session for SSEStreamHandler
    var urlSession: URLSession {
        return session
    }

    var jsonEncoder: JSONEncoder {
        return encoder
    }
}

// MARK: - Supporting Types

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

/// Type-erased Encodable wrapper for generic request bodies
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
