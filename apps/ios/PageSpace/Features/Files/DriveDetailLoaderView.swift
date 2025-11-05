import SwiftUI

struct DriveDetailLoaderView: View {
    let driveId: String

    @ObservedObject private var fileSystemService = FileSystemService.shared

    @State private var driveItem: DriveItem?
    @State private var isLoading = false
    @State private var errorMessage: String?

    var body: some View {
        Group {
            if let driveItem {
                DriveDetailView(driveItem: driveItem)
            } else if isLoading {
                VStack(spacing: DesignTokens.Spacing.medium) {
                    ProgressView()
                    Text("Loading drive...")
                        .font(.caption)
                        .foregroundColor(DesignTokens.Colors.mutedText)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let errorMessage {
                VStack(spacing: DesignTokens.Spacing.large) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 40))
                        .foregroundColor(DesignTokens.Colors.error)

                    Text(errorMessage)
                        .font(.body)
                        .foregroundColor(DesignTokens.Colors.mutedText)
                        .multilineTextAlignment(.center)

                    Button(action: {
                        Task { await fetchDrive() }
                    }) {
                        Text("Retry")
                            .fontWeight(.semibold)
                            .foregroundColor(.white)
                            .padding(.horizontal, DesignTokens.Spacing.large)
                            .padding(.vertical, DesignTokens.Spacing.small)
                            .background(DesignTokens.Colors.brandBlue)
                            .cornerRadius(DesignTokens.CornerRadius.medium)
                    }
                }
                .padding()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                VStack(spacing: DesignTokens.Spacing.medium) {
                    Image(systemName: "folder")
                        .font(.system(size: 40))
                        .foregroundColor(DesignTokens.Colors.mutedText)

                    Text("Drive not found")
                        .font(.headline)

                    Text("This drive may have been moved or you no longer have access.")
                        .font(.caption)
                        .foregroundColor(DesignTokens.Colors.mutedText)
                        .multilineTextAlignment(.center)
                }
                .padding()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .navigationBarTitleDisplayMode(.large)
        .task {
            await fetchDrive()
        }
        .onReceive(fileSystemService.$driveItems) { _ in
            if driveItem == nil {
                driveItem = fileSystemService.driveItems.first(where: { $0.drive.id == driveId })
            }
        }
    }

    private func fetchDrive() async {
        if let existing = fileSystemService.driveItems.first(where: { $0.drive.id == driveId }) {
            driveItem = existing
            return
        }

        isLoading = true
        errorMessage = nil

        await fileSystemService.loadDrives()

        isLoading = false

        if let existing = fileSystemService.driveItems.first(where: { $0.drive.id == driveId }) {
            driveItem = existing
        } else if let error = fileSystemService.error {
            errorMessage = error.localizedDescription
        } else {
            errorMessage = "We couldn't find this drive. Try refreshing your Files view."
        }
    }
}

#Preview {
    NavigationStack {
        DriveDetailLoaderView(driveId: "drive-id")
    }
}
