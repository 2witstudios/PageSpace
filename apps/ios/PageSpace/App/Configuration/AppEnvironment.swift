import Foundation

enum AppEnvironment {
    static let apiBaseURL: URL = {
        #if DEBUG
        // Local development server
        return URL(string: "http://localhost:3000")!
        #else
        // Production server
        return URL(string: "https://pagespace.ai")!
        #endif
    }()

    static let realtimeURL: URL = {
        #if DEBUG
        return URL(string: "http://localhost:3001")!
        #else
        return URL(string: "wss://pagespace.ai")!
        #endif
    }()

    static let apiVersion = "/api"
}
