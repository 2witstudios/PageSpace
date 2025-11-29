import Foundation

/// ViewModel for ChannelsListView
@MainActor
class ChannelsViewModel: ObservableObject {
    @Published var channels: [Channel] = []
    @Published var isLoading = false
    @Published var error: String?

    private let agentService = AgentService.shared

    func loadChannels() async {
        isLoading = true
        error = nil

        do {
            // Load all drives
            let drives = try await agentService.getDrives()

            var allChannels: [Channel] = []

            // For each drive, load pages and filter CHANNEL pages
            for drive in drives {
                do {
                    let pages = try await agentService.getPages(driveId: drive.id)
                    let channelPages = pages.filter { $0.type == .channel }

                    // Convert to Channel models
                    for page in channelPages {
                        let channel = Channel.from(page: page, drive: drive)
                        allChannels.append(channel)
                    }

                    print("Drive '\(drive.name)': Found \(channelPages.count) channels")
                } catch {
                    print("Failed to load channels for drive '\(drive.name)': \(error)")
                }
            }

            channels = allChannels.sorted { $0.title.lowercased() < $1.title.lowercased() }
            print("Total channels loaded: \(allChannels.count)")

        } catch {
            self.error = "Failed to load channels: \(error.localizedDescription)"
            print("Error loading channels: \(error)")
        }

        isLoading = false
    }
}
