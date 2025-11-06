import SwiftUI

@main
struct PageSpaceApp: App {
    @StateObject private var authManager = AuthManager.shared
    @StateObject private var realtimeService = RealtimeService.shared
    @Environment(\.scenePhase) var scenePhase

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(authManager)
                .environmentObject(realtimeService)
                .onChange(of: scenePhase) { oldPhase, newPhase in
                    handleScenePhaseChange(oldPhase, newPhase)
                }
                .onChange(of: authManager.isAuthenticated) { oldValue, newValue in
                    if newValue {
                        realtimeService.connect()
                    } else {
                        realtimeService.disconnect()
                    }
                }
        }
    }

    private func handleScenePhaseChange(_ oldPhase: ScenePhase, _ newPhase: ScenePhase) {
        switch newPhase {
        case .active:
            print("📱 App became active")
            // Validate token and refresh if needed
            Task { @MainActor in
                guard authManager.isAuthenticated,
                      let token = authManager.getToken() else {
                    return
                }

                // Check if token is expired or expiring soon (within 5 minutes)
                if authManager.isTokenExpiringSoon(token, bufferSeconds: 300) {
                    print("🔐 Token expiring soon - refreshing proactively on foreground")
                    do {
                        try await authManager.refreshToken()

                        // Reconnect Socket.IO with fresh token
                        if realtimeService.isConnected {
                            print("🔌 Reconnecting Socket.IO with fresh token")
                            realtimeService.disconnect()
                            realtimeService.connect()
                        }
                    } catch {
                        print("Failed to refresh token on foreground: \(error)")
                        authManager.logout()
                    }
                }
            }

        case .inactive:
            print("📱 App became inactive")

        case .background:
            print("📱 App entered background")

        @unknown default:
            break
        }
    }
}

struct ContentView: View {
    @EnvironmentObject var authManager: AuthManager

    var body: some View {
        Group {
            if authManager.isCheckingAuth {
                // Show loading screen while checking authentication
                ZStack {
                    Color(UIColor.systemBackground)
                        .ignoresSafeArea()

                    VStack(spacing: 20) {
                        Image(systemName: "brain.head.profile")
                            .font(.system(size: 60))
                            .foregroundColor(DesignTokens.Colors.primary)

                        ProgressView()
                            .progressViewStyle(CircularProgressViewStyle(
                                tint: DesignTokens.Colors.primary
                            ))
                            .scaleEffect(1.2)

                        Text("PageSpace")
                            .font(.title2)
                            .foregroundColor(.secondary)
                    }
                }
            } else if authManager.isAuthenticated {
                HomeView()
            } else {
                LoginView()
            }
        }
        .animation(.easeInOut(duration: 0.2), value: authManager.isCheckingAuth)
        .animation(.easeInOut(duration: 0.2), value: authManager.isAuthenticated)
    }
}
