//
//  ScrollToBottomButton.swift
//  PageSpace
//
//  Created by Claude Code on 2025-11-05.
//  Purpose: Floating scroll-to-bottom button (ChatGPT-style)
//

import SwiftUI

/// Floating button that appears when user scrolls away from bottom
/// Tapping scrolls to the bottom with haptic feedback
struct ScrollToBottomButton: View {
    let isVisible: Bool
    let action: () -> Void

    var body: some View {
        Button(action: {
            // Trigger haptic feedback
            let generator = UIImpactFeedbackGenerator(style: .light)
            generator.impactOccurred()

            // Perform scroll action
            action()
        }) {
            Image(systemName: "arrow.down.circle.fill")
                .font(.system(size: 44))
                .foregroundColor(.white)
                .background(
                    Circle()
                        .fill(DesignTokens.Colors.primary)
                        .frame(width: 44, height: 44)
                )
                .shadow(
                    color: Color.black.opacity(0.2),
                    radius: 8,
                    x: 0,
                    y: 4
                )
        }
        .opacity(isVisible ? 1.0 : 0.0)
        .scaleEffect(isVisible ? 1.0 : 0.8)
        .animation(.spring(response: 0.3, dampingFraction: 0.7), value: isVisible)
    }
}

/// Helper extension for easy integration in ChatView
extension View {
    func scrollToBottomButton(
        isVisible: Bool,
        action: @escaping () -> Void
    ) -> some View {
        ZStack(alignment: .bottomTrailing) {
            self

            if isVisible {
                ScrollToBottomButton(isVisible: isVisible, action: action)
                    .padding(.trailing, 16)
                    .padding(.bottom, 16)
            }
        }
    }
}

#Preview {
    VStack {
        ScrollView {
            VStack(spacing: 20) {
                ForEach(0..<50, id: \.self) { i in
                    Text("Message \(i)")
                        .padding()
                        .background(Color.gray.opacity(0.2))
                        .cornerRadius(8)
                }
            }
            .padding()
        }
        .scrollToBottomButton(isVisible: true) {
            print("Scroll to bottom tapped")
        }
    }
}
