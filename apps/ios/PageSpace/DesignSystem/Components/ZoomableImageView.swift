//
//  ZoomableImageView.swift
//  PageSpace
//
//  A UIScrollView-based image viewer with built-in pinch-to-zoom and pan support.
//  Similar to PDFKitView, this wraps UIKit for reliable zoom functionality.
//

import SwiftUI
import UIKit
import os.log

/// A zoomable image view that wraps UIScrollView for native pinch-to-zoom support
struct ZoomableImageView: UIViewRepresentable {
    let url: URL
    let logger: Logger
    let onImageLoaded: ((Data) -> Void)?

    init(url: URL, logger: Logger, onImageLoaded: ((Data) -> Void)? = nil) {
        self.url = url
        self.logger = logger
        self.onImageLoaded = onImageLoaded
    }

    func makeUIView(context: Context) -> UIScrollView {
        let scrollView = UIScrollView()
        scrollView.delegate = context.coordinator
        scrollView.minimumZoomScale = 1.0
        scrollView.maximumZoomScale = 5.0
        scrollView.showsHorizontalScrollIndicator = false
        scrollView.showsVerticalScrollIndicator = false
        scrollView.bouncesZoom = true

        let imageView = UIImageView()
        imageView.contentMode = .scaleAspectFit
        imageView.clipsToBounds = true
        scrollView.addSubview(imageView)

        // Store imageView reference in coordinator
        context.coordinator.imageView = imageView

        // Load image asynchronously with authentication
        Task {
            await context.coordinator.loadImage(from: url, into: imageView, scrollView: scrollView)
        }

        return scrollView
    }

    func updateUIView(_ uiView: UIScrollView, context: Context) {
        // No updates needed for static image
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(logger: logger, onImageLoaded: onImageLoaded)
    }

    class Coordinator: NSObject, UIScrollViewDelegate {
        let logger: Logger
        let onImageLoaded: ((Data) -> Void)?
        weak var imageView: UIImageView?

        init(logger: Logger, onImageLoaded: ((Data) -> Void)?) {
            self.logger = logger
            self.onImageLoaded = onImageLoaded
        }

        func viewForZooming(in scrollView: UIScrollView) -> UIView? {
            return imageView
        }

        func scrollViewDidZoom(_ scrollView: UIScrollView) {
            // Center image when zoomed
            centerImage(in: scrollView)
        }

        private func centerImage(in scrollView: UIScrollView) {
            guard let imageView = imageView else { return }

            let offsetX = max((scrollView.bounds.width - scrollView.contentSize.width) * 0.5, 0)
            let offsetY = max((scrollView.bounds.height - scrollView.contentSize.height) * 0.5, 0)

            imageView.center = CGPoint(
                x: scrollView.contentSize.width * 0.5 + offsetX,
                y: scrollView.contentSize.height * 0.5 + offsetY
            )
        }

        func loadImage(from url: URL, into imageView: UIImageView, scrollView: UIScrollView) async {
            do {
                // SECURITY: Create authenticated URLRequest
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

                guard let httpResponse = response as? HTTPURLResponse,
                      (200...299).contains(httpResponse.statusCode) else {
                    logger.error("Failed to load image: Invalid HTTP response (status: \((response as? HTTPURLResponse)?.statusCode ?? -1))")
                    return
                }

                // Verify content type is an image
                if let contentType = httpResponse.mimeType,
                   !contentType.starts(with: "image/") {
                    logger.warning("Unexpected content type for image: \(contentType)")
                }

                // Create UIImage from data
                guard let image = UIImage(data: data) else {
                    logger.error("Failed to create UIImage from data")
                    return
                }

                // Update UI on main thread
                await MainActor.run {
                    imageView.image = image

                    // Size image view to match image
                    imageView.frame.size = image.size

                    // Update scroll view content size
                    scrollView.contentSize = image.size

                    // Calculate scale to fit image in scroll view
                    let scrollViewSize = scrollView.bounds.size
                    let widthScale = scrollViewSize.width / image.size.width
                    let heightScale = scrollViewSize.height / image.size.height
                    let minScale = min(widthScale, heightScale)

                    scrollView.minimumZoomScale = minScale
                    scrollView.zoomScale = minScale

                    // Center the image
                    centerImage(in: scrollView)

                    // Notify parent that image data is available for sharing
                    onImageLoaded?(data)
                }

                logger.info("Successfully loaded image from \(url.absoluteString)")

            } catch {
                logger.error("Error loading image: \(error.localizedDescription)")
            }
        }
    }
}
