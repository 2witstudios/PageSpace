import SwiftUI

/// Channel model representing a CHANNEL type page
struct Channel: Identifiable, Hashable {
    let id: String
    let title: String
    let driveId: String
    let driveName: String
    let pageId: String
    let updatedAt: Date

    static func from(page: Page, drive: Drive) -> Channel {
        Channel(
            id: page.id,
            title: page.title,
            driveId: drive.id,
            driveName: drive.name,
            pageId: page.id,
            updatedAt: page.updatedAt
        )
    }
}

/// Full-screen channels view for CHANNEL type pages
/// Displays team chat channels grouped by drive
struct ChannelsListView: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var viewModel = ChannelsViewModel()

    var body: some View {
        Group {
            if viewModel.isLoading && viewModel.channels.isEmpty {
                ProgressView("Loading channels...")
            } else if viewModel.channels.isEmpty {
                emptyState
            } else {
                List {
                    ForEach(groupedChannels.keys.sorted(), id: \.self) { driveName in
                        if let channels = groupedChannels[driveName] {
                            Section {
                                ForEach(channels) { channel in
                                    Button {
                                        selectChannel(channel)
                                    } label: {
                                        ChannelRow(channel: channel)
                                    }
                                }
                            } header: {
                                HStack {
                                    Image(systemName: "folder")
                                    Text(driveName)
                                }
                            }
                        }
                    }
                }
                .refreshable {
                    await viewModel.loadChannels()
                }
            }
        }
        .navigationTitle("Channels")
        .navigationBarTitleDisplayMode(.large)
        .task {
            if viewModel.channels.isEmpty {
                await viewModel.loadChannels()
            }
        }
    }

    // MARK: - Actions

    private func selectChannel(_ channel: Channel) {
        // TODO: Create/load conversation for this channel and select it
        // For now, just dismiss to return to chat
        print("Selected channel: \(channel.title)")
        dismiss()
    }

    // MARK: - Computed Properties

    private var groupedChannels: [String: [Channel]] {
        Dictionary(grouping: viewModel.channels) { channel in
            channel.driveName
        }
    }

    private var emptyState: some View {
        VStack(spacing: 16) {
            Image(systemName: "number.circle")
                .font(.system(size: 60))
                .foregroundColor(.secondary)
            Text("No channels found")
                .font(.headline)
                .foregroundColor(.secondary)
            Text("Create a CHANNEL page in PageSpace to see it here")
                .font(.subheadline)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding()
    }
}

/// Channel row component
struct ChannelRow: View {
    let channel: Channel

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "number.circle.fill")
                .font(.title3)
                .foregroundColor(DesignTokens.Colors.channel)
                .frame(width: 32)

            VStack(alignment: .leading, spacing: 4) {
                Text(channel.title)
                    .font(.headline)
                    .foregroundColor(.primary)

                Text(channel.driveName)
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .lineLimit(1)
            }

            Spacer()

            Text(relativeDate(channel.updatedAt))
                .font(.caption2)
                .foregroundColor(.secondary)
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
    }

    private func relativeDate(_ date: Date) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: Date())
    }
}

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

#Preview {
    NavigationStack {
        ChannelsListView()
    }
}
