import SwiftUI

struct AvatarView: View {
    let url: URL?
    let name: String
    let size: CGFloat

    init(url: URL?, name: String, size: CGFloat = 40) {
        self.url = url
        self.name = name
        self.size = size
    }

    var body: some View {
        Group {
            if let url = url {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .empty:
                        ProgressView()
                            .frame(width: size, height: size)
                    case .success(let image):
                        image
                            .resizable()
                            .aspectRatio(contentMode: .fill)
                            .frame(width: size, height: size)
                            .clipShape(Circle())
                    case .failure:
                        fallbackInitials
                    @unknown default:
                        fallbackInitials
                    }
                }
            } else {
                fallbackInitials
            }
        }
    }

    private var fallbackInitials: some View {
        ZStack {
            Circle()
                .fill(avatarColor)
                .frame(width: size, height: size)

            Text(initials)
                .font(.system(size: size * 0.4, weight: .semibold))
                .foregroundColor(.white)
        }
    }

    private var initials: String {
        let words = name.split(separator: " ")
        if words.count >= 2 {
            // First letter of first and last name
            let first = words.first?.first ?? Character("")
            let last = words.last?.first ?? Character("")
            return "\(first)\(last)".uppercased()
        } else if let first = words.first?.first {
            // Just first letter
            return String(first).uppercased()
        } else {
            return "?"
        }
    }

    private var avatarColor: Color {
        // Generate consistent color based on name - using brand blue gradient palette
        let hash = name.hashValue
        let colors: [Color] = [
            DesignTokens.Colors.brandBlue,
            DesignTokens.Colors.brandBlue.opacity(0.8),
            DesignTokens.Colors.brandBlueDark,
            DesignTokens.Colors.brandBlueDark.opacity(0.9),
            Color(hue: 0.65, saturation: 0.5, brightness: 0.8),  // Lighter variant
            Color(hue: 0.66, saturation: 0.6, brightness: 0.65), // Slightly different hue
        ]
        return colors[abs(hash) % colors.count]
    }
}

#Preview("Avatar with Image") {
    AvatarView(
        url: URL(string: "https://i.pravatar.cc/150?img=1"),
        name: "John Doe",
        size: 48
    )
}

#Preview("Avatar Fallback - Full Name") {
    AvatarView(
        url: nil,
        name: "Jane Smith",
        size: 48
    )
}

#Preview("Avatar Fallback - Single Name") {
    AvatarView(
        url: nil,
        name: "Alice",
        size: 48
    )
}

#Preview("Avatar Sizes") {
    VStack(spacing: 16) {
        AvatarView(url: nil, name: "Small", size: 24)
        AvatarView(url: nil, name: "Medium", size: 40)
        AvatarView(url: nil, name: "Large", size: 56)
        AvatarView(url: nil, name: "XLarge", size: 72)
    }
}
