import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
  Sequence,
} from "remotion";
import { DESIGN_TOKENS, Theme } from "../Root";

interface HeroCompositionProps {
  theme: Theme;
}

export const HeroComposition: React.FC<HeroCompositionProps> = ({ theme }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const colors = {
    background:
      theme === "dark"
        ? DESIGN_TOKENS.colors.background.dark
        : DESIGN_TOKENS.colors.background.light,
    foreground:
      theme === "dark"
        ? DESIGN_TOKENS.colors.foreground.dark
        : DESIGN_TOKENS.colors.foreground.light,
    muted:
      theme === "dark"
        ? DESIGN_TOKENS.colors.muted.dark
        : DESIGN_TOKENS.colors.muted.light,
    mutedForeground:
      theme === "dark"
        ? DESIGN_TOKENS.colors.mutedForeground.dark
        : DESIGN_TOKENS.colors.mutedForeground.light,
    border:
      theme === "dark"
        ? DESIGN_TOKENS.colors.border.dark
        : DESIGN_TOKENS.colors.border.light,
    primary: DESIGN_TOKENS.colors.primary,
    primaryForeground: DESIGN_TOKENS.colors.primaryForeground,
  };

  // Animation phases
  const logoScale = spring({
    frame,
    fps,
    config: { damping: 200 },
  });

  const headlineOpacity = interpolate(frame, [30, 60], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const headlineY = interpolate(frame, [30, 60], [30, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const subheadlineOpacity = interpolate(frame, [50, 80], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const mockupOpacity = interpolate(frame, [80, 120], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const mockupScale = interpolate(frame, [80, 120], [0.95, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      className={theme}
      style={{
        backgroundColor: colors.background,
        fontFamily: DESIGN_TOKENS.fonts.sans,
        padding: 80,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "flex-start",
      }}
    >
      {/* Logo and Badge */}
      <Sequence from={0} durationInFrames={durationInFrames}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            marginBottom: 40,
            transform: `scale(${logoScale})`,
          }}
        >
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 14,
              backgroundColor: colors.primary,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <svg
              width="32"
              height="32"
              viewBox="0 0 24 24"
              fill="none"
              stroke={colors.primaryForeground}
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
            </svg>
          </div>
          <span
            style={{
              fontSize: 36,
              fontWeight: 700,
              color: colors.foreground,
            }}
          >
            PageSpace
          </span>
        </div>
      </Sequence>

      {/* Headline */}
      <Sequence from={0} durationInFrames={durationInFrames}>
        <h1
          style={{
            fontSize: 72,
            fontWeight: 700,
            color: colors.foreground,
            textAlign: "center",
            marginBottom: 24,
            opacity: headlineOpacity,
            transform: `translateY(${headlineY}px)`,
          }}
        >
          You, your team, and AI—
          <br />
          <span style={{ color: colors.primary }}>working together</span>
        </h1>
      </Sequence>

      {/* Subheadline */}
      <Sequence from={0} durationInFrames={durationInFrames}>
        <p
          style={{
            fontSize: 28,
            color: colors.mutedForeground,
            textAlign: "center",
            maxWidth: 800,
            lineHeight: 1.5,
            opacity: subheadlineOpacity,
            marginBottom: 60,
          }}
        >
          A unified workspace where AI agents live alongside your documents,
          tasks, and conversations.
        </p>
      </Sequence>

      {/* App Mockup */}
      <Sequence from={0} durationInFrames={durationInFrames}>
        <div
          style={{
            width: "100%",
            maxWidth: 1400,
            height: 500,
            borderRadius: 16,
            border: `1px solid ${colors.border}`,
            backgroundColor: colors.muted,
            opacity: mockupOpacity,
            transform: `scale(${mockupScale})`,
            display: "flex",
            overflow: "hidden",
            boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.25)",
          }}
        >
          {/* Sidebar */}
          <div
            style={{
              width: 250,
              borderRight: `1px solid ${colors.border}`,
              backgroundColor:
                theme === "dark"
                  ? "rgba(0,0,0,0.2)"
                  : "rgba(255,255,255,0.5)",
              padding: 20,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                marginBottom: 24,
              }}
            >
              <div
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 8,
                  backgroundColor: colors.primary + "20",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke={colors.primary}
                  strokeWidth="2"
                >
                  <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
                  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
              </div>
              <span
                style={{
                  fontSize: 14,
                  fontWeight: 500,
                  color: colors.foreground,
                }}
              >
                My Workspace
              </span>
            </div>

            {/* Sidebar Items */}
            {["Documents", "Channels", "Tasks", "Calendar"].map(
              (item, index) => (
                <div
                  key={item}
                  style={{
                    padding: "10px 12px",
                    borderRadius: 8,
                    marginBottom: 4,
                    backgroundColor:
                      index === 0 ? colors.primary + "15" : "transparent",
                    color: index === 0 ? colors.primary : colors.mutedForeground,
                    fontSize: 14,
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                  }}
                >
                  <div
                    style={{
                      width: 18,
                      height: 18,
                      borderRadius: 4,
                      backgroundColor: index === 0 ? colors.primary : colors.border,
                    }}
                  />
                  {item}
                </div>
              )
            )}
          </div>

          {/* Main Content */}
          <div style={{ flex: 1, padding: 24 }}>
            <div
              style={{
                fontSize: 20,
                fontWeight: 600,
                color: colors.foreground,
                marginBottom: 8,
              }}
            >
              Q1 Planning Document
            </div>
            <div
              style={{
                fontSize: 13,
                color: colors.mutedForeground,
                marginBottom: 24,
              }}
            >
              Last edited 2 minutes ago
            </div>

            {/* Content Lines */}
            {[75, 100, 85, 60].map((width, i) => (
              <div
                key={i}
                style={{
                  height: 16,
                  width: `${width}%`,
                  backgroundColor: colors.border,
                  borderRadius: 4,
                  marginBottom: 12,
                }}
              />
            ))}

            {/* AI Suggestion */}
            <div
              style={{
                marginTop: 24,
                padding: 16,
                borderRadius: 12,
                backgroundColor: colors.primary + "10",
                border: `1px solid ${colors.primary}30`,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginBottom: 8,
                }}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke={colors.primary}
                  strokeWidth="2"
                >
                  <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
                </svg>
                <span
                  style={{ fontSize: 13, fontWeight: 500, color: colors.primary }}
                >
                  AI Suggestion
                </span>
              </div>
              <div
                style={{
                  height: 12,
                  width: "80%",
                  backgroundColor: colors.primary + "30",
                  borderRadius: 4,
                }}
              />
            </div>
          </div>

          {/* AI Panel */}
          <div
            style={{
              width: 300,
              borderLeft: `1px solid ${colors.border}`,
              backgroundColor:
                theme === "dark"
                  ? "rgba(0,0,0,0.1)"
                  : "rgba(255,255,255,0.3)",
              padding: 20,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                marginBottom: 20,
              }}
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke={colors.primary}
                strokeWidth="2"
              >
                <path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2" />
                <path d="M7.5 13a.5.5 0 1 1-1 0 .5.5 0 0 1 1 0Z" />
                <path d="M17.5 13a.5.5 0 1 1-1 0 .5.5 0 0 1 1 0Z" />
                <path d="M10 16s.5 1 2 1 2-1 2-1" />
              </svg>
              <span
                style={{
                  fontSize: 14,
                  fontWeight: 500,
                  color: colors.foreground,
                }}
              >
                AI Assistant
              </span>
            </div>

            {/* Chat bubble */}
            <div
              style={{
                backgroundColor: colors.muted,
                padding: 12,
                borderRadius: 12,
                fontSize: 13,
                color: colors.mutedForeground,
                marginBottom: 12,
              }}
            >
              How can I help with your Q1 planning?
            </div>

            {/* User message */}
            <div
              style={{
                backgroundColor: colors.primary + "15",
                padding: 12,
                borderRadius: 12,
                fontSize: 13,
                color: colors.foreground,
                marginLeft: 20,
              }}
            >
              Summarize the key objectives
            </div>
          </div>
        </div>
      </Sequence>
    </AbsoluteFill>
  );
};
