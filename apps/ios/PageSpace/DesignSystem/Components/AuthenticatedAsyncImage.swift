//
//  AuthenticatedAsyncImage.swift
//  PageSpace
//
//  Created on 2025-11-03.
//  Authenticated image loader with JWT token support
//  SECURITY: Adds Authorization and CSRF headers to image requests
//

import SwiftUI
import os.log

/// SwiftUI view that loads images from authenticated endpoints
/// Automatically includes JWT and CSRF tokens in requests
struct AuthenticatedAsyncImage<Content: View, Placeholder: View>: View {
    let url: URL
    let content: (Image) -> Content
    let placeholder: () -> Placeholder

    @State private var phase: LoadPhase = .loading

    private let logger = Logger(subsystem: "com.pagespace.ios", category: "AuthenticatedImage")

    init(
        url: URL,
        @ViewBuilder content: @escaping (Image) -> Content,
        @ViewBuilder placeholder: @escaping () -> Placeholder
    ) {
        self.url = url
        self.content = content
        self.placeholder = placeholder
    }

    var body: some View {
        Group {
            switch phase {
            case .loading:
                placeholder()
            case .success(let image):
                content(image)
            case .failure:
                placeholder()
            }
        }
        .task {
            await loadImage()
        }
    }

    private func loadImage() async {
        do {
            // Create authenticated URLRequest
            var request = URLRequest(url: url)
            request.httpMethod = "GET"

            // Add authentication headers
            if let token = AuthManager.shared.getToken() {
                request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            } else {
                logger.warning("No JWT token available for image request")
            }

            if let csrfToken = AuthManager.shared.getCSRFToken() {
                request.setValue(csrfToken, forHTTPHeaderField: "X-CSRF-Token")
            }

            // Make authenticated request
            let (data, response) = try await URLSession.shared.data(for: request)

            // Validate HTTP response
            guard let httpResponse = response as? HTTPURLResponse else {
                logger.error("Invalid response type for image request")
                phase = .failure
                return
            }

            guard (200...299).contains(httpResponse.statusCode) else {
                logger.error("Image request failed with status: \(httpResponse.statusCode)")
                phase = .failure
                return
            }

            // Create UIImage from data
            guard let uiImage = UIImage(data: data) else {
                logger.error("Failed to create UIImage from response data")
                phase = .failure
                return
            }

            // Update phase on main thread
            await MainActor.run {
                phase = .success(Image(uiImage: uiImage))
            }

        } catch {
            logger.error("Failed to load authenticated image: \(error.localizedDescription)")
            await MainActor.run {
                phase = .failure
            }
        }
    }

    enum LoadPhase {
        case loading
        case success(Image)
        case failure
    }
}

// MARK: - Convenience Initializers

extension AuthenticatedAsyncImage where Content == Image, Placeholder == ProgressView<EmptyView, EmptyView> {
    /// Convenience initializer with default placeholder (ProgressView)
    init(url: URL) {
        self.init(
            url: url,
            content: { image in image },
            placeholder: { ProgressView() }
        )
    }
}

extension AuthenticatedAsyncImage where Placeholder == EmptyView {
    /// Convenience initializer with custom content builder and no placeholder
    init(url: URL, @ViewBuilder content: @escaping (Image) -> Content) {
        self.init(
            url: url,
            content: content,
            placeholder: { EmptyView() }
        )
    }
}
