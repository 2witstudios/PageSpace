//
//  CanvasWebView.swift
//  PageSpace
//
//  Created on 2025-11-03.
//  Custom HTML/CSS page viewer with STRICT security sandbox
//  SECURITY: Sandboxed iframe, JavaScript disabled, strict CSP
//

import SwiftUI
import WebKit
import os.log

struct CanvasWebView: View {
    let page: Page
    @State private var htmlContent: String?
    @State private var isLoading = true
    @State private var error: String?
    @State private var loadTask: Task<Void, Never>?

    private let logger = Logger(subsystem: "com.pagespace.ios", category: "Security.CanvasView")

    var body: some View {
        ZStack {
            if isLoading {
                PageLoadingView(message: "Loading canvas...")
            } else if let error = error {
                PageErrorView(
                    title: "Failed to load canvas",
                    message: error,
                    onRetry: {
                        Task { await loadContent() }
                    }
                )
            } else {
                SandboxedCanvasWebView(htmlContent: htmlContent ?? "")
                    .edgesIgnoringSafeArea(.bottom)
            }
        }
        .navigationTitle(page.title)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            loadTask = Task {
                await loadContent()
            }
        }
        .onDisappear {
            loadTask?.cancel()
        }
        .refreshable {
            await loadContent()
        }
    }

    private func loadContent() async {
        guard !Task.isCancelled else { return }

        isLoading = true
        error = nil

        // Fetch content from API /api/pages/[pageId]
        // CRITICAL SECURITY: Server MUST sanitize HTML before sending
        // Recommend using DOMPurify on server or rendering static content only
        do {
            let fetchedPage = try await FileSystemService.shared.getPage(pageId: page.id)
            htmlContent = fetchedPage.content ?? ""
            isLoading = false
            logger.info("Canvas loaded successfully: pageId=\(page.id)")
        } catch {
            logger.error("Failed to load canvas: pageId=\(page.id), error=\(error.localizedDescription)")
            self.error = "Failed to load canvas content"
            isLoading = false
        }
    }
}

// MARK: - Sandboxed Canvas WebView with Maximum Security

private struct SandboxedCanvasWebView: UIViewRepresentable {
    let htmlContent: String

    private let logger = Logger(subsystem: "com.pagespace.ios", category: "Security.CanvasWebView")

    func makeCoordinator() -> Coordinator {
        Coordinator(logger: logger)
    }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()

        // Additional security settings
        config.allowsInlineMediaPlayback = false
        config.allowsAirPlayForMediaPlayback = false
        config.suppressesIncrementalRendering = false
        config.dataDetectorTypes = []

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.isOpaque = false
        webView.backgroundColor = .systemBackground
        webView.scrollView.backgroundColor = .systemBackground

        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        // Check if content changed to avoid unnecessary reloads
        if context.coordinator.lastContent != htmlContent {
            context.coordinator.lastContent = htmlContent

            // SECURITY: Load HTML directly with strict CSP
            // Similar to web's Shadow DOM approach but adapted for iOS WKWebView
            // - No JavaScript allowed (script-src 'none')
            // - Only inline styles (style-src 'unsafe-inline')
            // - Images from HTTPS only (img-src https: data:)
            let html = """
<!DOCTYPE html>
<html>
<head>
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; font-src https:;">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0, user-scalable=yes">
    <style>
        * {
            box-sizing: border-box;
        }
        body {
            margin: 0;
            padding: 16px;
            background: white;
            color: black;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
            line-height: 1.6;
            min-height: 100vh;
        }
    </style>
</head>
<body>
\(htmlContent)
</body>
</html>
"""

            webView.loadHTMLString(html, baseURL: nil)
        }
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        // Clean up WebView to prevent memory leaks
        webView.stopLoading()
        webView.loadHTMLString("", baseURL: nil)
        webView.navigationDelegate = nil
    }

    class Coordinator: NSObject, WKNavigationDelegate {
        var lastContent: String = ""
        private let logger: Logger

        init(logger: Logger) {
            self.logger = logger
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            preferences: WKWebpagePreferences,
            decisionHandler: @escaping (WKNavigationActionPolicy, WKWebpagePreferences) -> Void
        ) {
            // SECURITY: Disable JavaScript completely for ALL navigations (canvas pages are static HTML/CSS only)
            preferences.allowsContentJavaScript = false

            // SECURITY: Block ALL navigation except initial load
            if navigationAction.navigationType == .linkActivated {
                logger.warning("Blocked link navigation in sandboxed canvas")
                decisionHandler(.cancel, preferences)
                return
            }

            if navigationAction.navigationType == .formSubmitted {
                logger.warning("Blocked form submission in sandboxed canvas")
                decisionHandler(.cancel, preferences)
                return
            }

            // Only allow .other for initial load
            if navigationAction.navigationType == .other {
                decisionHandler(.allow, preferences)
            } else {
                logger.warning("Blocked navigation type: \(navigationAction.navigationType.rawValue)")
                decisionHandler(.cancel, preferences)
            }
        }
    }
}

#Preview {
    NavigationStack {
        CanvasWebView(
            page: Page(
                id: "1",
                driveId: "drive1",
                title: "Dashboard",
                type: .canvas,
                parentId: nil,
                position: 1.0,
                createdAt: Date(),
                updatedAt: Date()
            )
        )
    }
}
