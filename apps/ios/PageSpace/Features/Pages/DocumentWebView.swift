//
//  DocumentWebView.swift
//  PageSpace
//
//  Created on 2025-11-03.
//  Read-only rich text document viewer using WKWebView
//  SECURITY: JavaScript disabled, strict CSP, sanitization required
//

import SwiftUI
import WebKit
import os.log

struct DocumentWebView: View {
    let page: Page
    @State private var htmlContent: String?
    @State private var isLoading = true
    @State private var error: String?
    @State private var loadTask: Task<Void, Never>?

    private let logger = Logger(subsystem: "com.pagespace.ios", category: "Security.DocumentView")

    var body: some View {
        ZStack {
            if isLoading {
                PageLoadingView(message: "Loading document...")
            } else if let error = error {
                PageErrorView(
                    title: "Failed to load document",
                    message: error,
                    onRetry: {
                        Task { await loadContent() }
                    }
                )
            } else {
                SecureDocumentWebView(htmlContent: htmlContent ?? "")
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
        // SECURITY: Server MUST sanitize HTML before sending to client
        // Backend should use DOMPurify or similar to remove dangerous content
        do {
            let fetchedPage = try await FileSystemService.shared.getPage(pageId: page.id)
            htmlContent = fetchedPage.content ?? ""
            isLoading = false
            logger.info("Document loaded successfully: pageId=\(page.id)")
        } catch {
            logger.error("Failed to load document: pageId=\(page.id), error=\(error.localizedDescription)")
            self.error = "Failed to load document content"
            isLoading = false
        }
    }
}

// MARK: - Secure WebView Wrapper with JavaScript Disabled

private struct SecureDocumentWebView: UIViewRepresentable {
    let htmlContent: String

    private let logger = Logger(subsystem: "com.pagespace.ios", category: "Security.WebView")

    func makeCoordinator() -> Coordinator {
        Coordinator(logger: logger)
    }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()

        // Security settings
        config.allowsInlineMediaPlayback = true
        config.suppressesIncrementalRendering = false
        config.allowsAirPlayForMediaPlayback = false

        // Disable data detection to prevent unexpected behavior
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

            // SECURITY: Strict Content Security Policy
            // - default-src 'none': Block all by default
            // - style-src 'unsafe-inline': Allow inline styles only
            // - img-src https: data:: Allow images from HTTPS and data URLs
            // - script-src 'none': No JavaScript allowed
            let html = """
            <!DOCTYPE html>
            <html>
            <head>
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; font-src https:; media-src https:;">
                <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0, user-scalable=yes">
                <style>
                    :root {
                        color-scheme: light dark;
                    }
                    body {
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                        font-size: 16px;
                        line-height: 1.6;
                        padding: 16px;
                        margin: 0;
                        background-color: transparent;
                        color: var(--text-primary, #000);
                    }
                    @media (prefers-color-scheme: dark) {
                        body {
                            color: var(--text-primary, #fff);
                        }
                    }
                    img {
                        max-width: 100%;
                        height: auto;
                    }
                    pre {
                        background-color: #f5f5f5;
                        padding: 12px;
                        border-radius: 8px;
                        overflow-x: auto;
                    }
                    @media (prefers-color-scheme: dark) {
                        pre {
                            background-color: #2c2c2c;
                        }
                    }
                    code {
                        background-color: #f5f5f5;
                        padding: 2px 6px;
                        border-radius: 4px;
                        font-family: 'SF Mono', Monaco, Consolas, monospace;
                    }
                    @media (prefers-color-scheme: dark) {
                        code {
                            background-color: #2c2c2c;
                        }
                    }
                    a {
                        color: #007AFF;
                        text-decoration: none;
                    }
                    blockquote {
                        border-left: 4px solid #007AFF;
                        padding-left: 16px;
                        margin-left: 0;
                        color: #666;
                    }
                    @media (prefers-color-scheme: dark) {
                        blockquote {
                            color: #999;
                        }
                    }
                    table {
                        width: 100%;
                        border-collapse: collapse;
                    }
                    th, td {
                        border: 1px solid #ddd;
                        padding: 8px;
                        text-align: left;
                    }
                    @media (prefers-color-scheme: dark) {
                        th, td {
                            border-color: #444;
                        }
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
            // SECURITY: Disable JavaScript completely for ALL navigations (documents are static HTML)
            preferences.allowsContentJavaScript = false

            // SECURITY: Block all navigation except initial load
            if navigationAction.navigationType == .linkActivated {
                logger.warning("Blocked external navigation attempt in document viewer")
                decisionHandler(.cancel, preferences)
                return
            }

            // Only allow other for initial load
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
        DocumentWebView(
            page: Page(
                id: "1",
                driveId: "drive1",
                title: "Sample Document",
                type: .document,
                parentId: nil,
                position: 1.0,
                createdAt: Date(),
                updatedAt: Date()
            )
        )
    }
}
