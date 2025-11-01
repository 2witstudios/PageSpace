import SwiftUI

@main
struct PageSpaceApp: App {
    @StateObject private var authManager = AuthManager.shared
    @StateObject private var realtimeService = RealtimeService.shared

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(authManager)
                .environmentObject(realtimeService)
                .onAppear {
                    // Connect to Socket.IO when app launches
                    if authManager.isAuthenticated {
                        realtimeService.connect()
                    }
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
}

struct ContentView: View {
    @EnvironmentObject var authManager: AuthManager

    var body: some View {
        if authManager.isAuthenticated {
            NavigationStack {
                HomeView()
            }
        } else {
            LoginView()
        }
    }
}
