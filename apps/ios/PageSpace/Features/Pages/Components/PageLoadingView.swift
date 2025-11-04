//
//  PageLoadingView.swift
//  PageSpace
//
//  Created on 2025-11-03.
//  Reusable loading state for page views
//

import SwiftUI

struct PageLoadingView: View {
    let message: String

    init(message: String = "Loading page...") {
        self.message = message
    }

    var body: some View {
        VStack(spacing: DesignTokens.Spacing.large) {
            ProgressView()
                .scaleEffect(1.2)

            Text(message)
                .font(.subheadline)
                .foregroundColor(DesignTokens.Colors.mutedText)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemBackground))
    }
}

#Preview {
    PageLoadingView()
}

#Preview("Custom Message") {
    PageLoadingView(message: "Loading document...")
}
