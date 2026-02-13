import { ImageResponse } from "next/og";

export const runtime = "edge";

export async function GET() {
  return new ImageResponse(
    (
      <div
        style={{
          height: "100%",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#0f0f0f",
          backgroundImage:
            "radial-gradient(circle at 25% 25%, #1a1a2e 0%, transparent 50%), radial-gradient(circle at 75% 75%, #16213e 0%, transparent 50%)",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 24,
          }}
        >
          {/* Logo placeholder - simple text for now */}
          <div
            style={{
              fontSize: 72,
              fontWeight: 800,
              background: "linear-gradient(135deg, #60a5fa, #a78bfa)",
              backgroundClip: "text",
              color: "transparent",
              letterSpacing: "-0.02em",
            }}
          >
            PageSpace
          </div>
          <div
            style={{
              fontSize: 32,
              color: "#e5e5e5",
              fontWeight: 400,
              textAlign: "center",
              maxWidth: 800,
            }}
          >
            AI-Powered Unified Workspace
          </div>
          <div
            style={{
              fontSize: 20,
              color: "#a3a3a3",
              textAlign: "center",
              maxWidth: 700,
              marginTop: 8,
            }}
          >
            Documents • Tasks • Calendar • Channels • AI Collaboration
          </div>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
    }
  );
}
