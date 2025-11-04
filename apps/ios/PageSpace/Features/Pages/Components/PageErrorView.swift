//
//  PageErrorView.swift
//  PageSpace
//
//  Created on 2025-11-03.
//  Reusable error state for page views with retry
//

import SwiftUI

struct PageErrorView: View {
    let title: String
    let message: String
    let onRetry: () -> Void

    init(
        title: String = "Failed to load page",
        message: String = "An error occurred while loading this page.",
        onRetry: @escaping () -> Void
    ) {
        self.title = title
        self.message = message
        self.onRetry = onRetry
    }

    var body: some View {
        VStack(spacing: DesignTokens.Spacing.large) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 48))
                .foregroundColor(DesignTokens.Colors.error)

            Text(title)
                .font(.headline)
                .foregroundColor(.primary)

            Text(message)
                .font(.subheadline)
                .foregroundColor(DesignTokens.Colors.mutedText)
                .multilineTextAlignment(.center)
                .padding(.horizontal, DesignTokens.Spacing.xlarge)

            Button {
                onRetry()
            } label: {
                Text("Retry")
                    .fontWeight(.semibold)
                    .foregroundColor(.white)
                    .padding(.horizontal, DesignTokens.Spacing.large)
                    .padding(.vertical, DesignTokens.Spacing.small)
                    .background(DesignTokens.Colors.brandBlue)
                    .cornerRadius(DesignTokens.CornerRadius.medium)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemBackground))
    }
}

#Preview {
    PageErrorView(
        title: "Failed to load document",
        message: "The document could not be loaded. Please check your connection and try again.",
        onRetry: {
            print("Retry tapped")
        }
    )
}
