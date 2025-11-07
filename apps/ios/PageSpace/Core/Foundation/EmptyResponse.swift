import Foundation

/// Empty response type for requests that return no body (204 No Content, DELETE, etc.)
struct EmptyResponse: Codable {
    init() {}
}
