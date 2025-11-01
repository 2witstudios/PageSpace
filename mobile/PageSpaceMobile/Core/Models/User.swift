import Foundation

struct User: Identifiable, Codable {
    let id: String
    let email: String
    let name: String?
    let createdAt: Date
}

struct LoginRequest: Codable {
    let email: String
    let password: String
}

struct LoginResponse: Codable {
    let user: User
    let token: String
    let csrfToken: String
}

struct AISettings: Codable {
    let provider: String
    let model: String
    let apiKeys: [String: String]?

    enum CodingKeys: String, CodingKey {
        case provider, model, apiKeys
    }
}
