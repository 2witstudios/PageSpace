import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { DESIGN_TOKENS, Theme } from "../Root";

interface ChannelsCompositionProps {
  theme: Theme;
}

export const ChannelsComposition: React.FC<ChannelsCompositionProps> = ({
  theme,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

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

  const containerScale = spring({
    frame,
    fps,
    config: { damping: 200 },
  });

  // Message animations
  const message1Opacity = interpolate(frame, [30, 50], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const message2Opacity = interpolate(frame, [70, 90], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const aiResponseOpacity = interpolate(frame, [120, 150], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // AI typing dots animation
  const typingDot1 = Math.sin(frame * 0.2) > 0 ? 1 : 0.3;
  const typingDot2 = Math.sin(frame * 0.2 + 2) > 0 ? 1 : 0.3;
  const typingDot3 = Math.sin(frame * 0.2 + 4) > 0 ? 1 : 0.3;

  // AI response typing
  const aiText =
    "Based on your positioning doc, here's a draft email that highlights our key differentiators...";
  const aiTypedChars = Math.min(
    Math.floor(interpolate(frame, [150, 250], [0, aiText.length])),
    aiText.length
  );
  const displayedAiText = aiText.slice(0, aiTypedChars);

  return (
    <AbsoluteFill
      className={theme}
      style={{
        backgroundColor: colors.background,
        fontFamily: DESIGN_TOKENS.fonts.sans,
        padding: 60,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 900,
          transform: `scale(${containerScale})`,
        }}
      >
        {/* Channel Container */}
        <div
          style={{
            borderRadius: 16,
            border: `1px solid ${colors.border}`,
            backgroundColor:
              theme === "dark" ? "rgba(0,0,0,0.3)" : "rgba(255,255,255,0.9)",
            boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.25)",
            overflow: "hidden",
          }}
        >
          {/* Channel Header */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "16px 24px",
              borderBottom: `1px solid ${colors.border}`,
              backgroundColor: colors.muted + "40",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 18, color: colors.mutedForeground }}>
                #
              </span>
              <span
                style={{
                  fontSize: 16,
                  fontWeight: 600,
                  color: colors.foreground,
                }}
              >
                product-launch
              </span>
              <span
                style={{
                  fontSize: 13,
                  color: colors.mutedForeground,
                }}
              >
                12 members
              </span>
            </div>

            {/* Avatars */}
            <div style={{ display: "flex", marginLeft: -8 }}>
              {[
                { bg: "#3B82F6", letter: "S" },
                { bg: "#10B981", letter: "M" },
                { bg: colors.primary, isAI: true },
              ].map((avatar, i) => (
                <div
                  key={i}
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: "50%",
                    backgroundColor: avatar.bg,
                    border: `2px solid ${colors.background}`,
                    marginLeft: i > 0 ? -8 : 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 12,
                    fontWeight: 600,
                    color: "white",
                  }}
                >
                  {avatar.isAI ? (
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="white"
                      strokeWidth="2"
                    >
                      <path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2" />
                    </svg>
                  ) : (
                    avatar.letter
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Messages */}
          <div style={{ padding: 24, minHeight: 350 }}>
            {/* Message 1 */}
            <div
              style={{
                display: "flex",
                gap: 12,
                marginBottom: 20,
                opacity: message1Opacity,
              }}
            >
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: "50%",
                  backgroundColor: "#3B82F6",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "white",
                  fontWeight: 600,
                  flexShrink: 0,
                }}
              >
                S
              </div>
              <div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    marginBottom: 4,
                  }}
                >
                  <span
                    style={{
                      fontWeight: 600,
                      fontSize: 15,
                      color: colors.foreground,
                    }}
                  >
                    Sarah
                  </span>
                  <span style={{ fontSize: 12, color: colors.mutedForeground }}>
                    10:34 AM
                  </span>
                </div>
                <p
                  style={{
                    fontSize: 15,
                    color: colors.mutedForeground,
                    lineHeight: 1.5,
                  }}
                >
                  We need to finalize the launch email copy.{" "}
                  <span
                    style={{ color: colors.primary, fontWeight: 500 }}
                  >
                    @Marketing-AI
                  </span>{" "}
                  can you draft something based on our positioning doc?
                </p>
              </div>
            </div>

            {/* Message 2 */}
            <div
              style={{
                display: "flex",
                gap: 12,
                marginBottom: 20,
                opacity: message2Opacity,
              }}
            >
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: "50%",
                  backgroundColor: "#10B981",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "white",
                  fontWeight: 600,
                  flexShrink: 0,
                }}
              >
                M
              </div>
              <div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    marginBottom: 4,
                  }}
                >
                  <span
                    style={{
                      fontWeight: 600,
                      fontSize: 15,
                      color: colors.foreground,
                    }}
                  >
                    Marcus
                  </span>
                  <span style={{ fontSize: 12, color: colors.mutedForeground }}>
                    10:35 AM
                  </span>
                </div>
                <p
                  style={{
                    fontSize: 15,
                    color: colors.mutedForeground,
                    lineHeight: 1.5,
                  }}
                >
                  Good idea! Let&apos;s also get{" "}
                  <span style={{ color: colors.primary, fontWeight: 500 }}>
                    @Code-Review-AI
                  </span>{" "}
                  to check the email template code.
                </p>
              </div>
            </div>

            {/* AI Response */}
            <div
              style={{
                display: "flex",
                gap: 12,
                opacity: aiResponseOpacity,
              }}
            >
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: "50%",
                  background: `linear-gradient(135deg, ${colors.primary} 0%, ${colors.primary}99 100%)`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="white"
                  strokeWidth="2"
                >
                  <path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2" />
                </svg>
              </div>
              <div style={{ flex: 1 }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    marginBottom: 4,
                  }}
                >
                  <span
                    style={{
                      fontWeight: 600,
                      fontSize: 15,
                      color: colors.primary,
                    }}
                  >
                    Marketing AI
                  </span>
                  <span
                    style={{
                      fontSize: 10,
                      backgroundColor: colors.primary + "20",
                      color: colors.primary,
                      padding: "2px 6px",
                      borderRadius: 4,
                    }}
                  >
                    AI
                  </span>
                  <span style={{ fontSize: 12, color: colors.mutedForeground }}>
                    10:35 AM
                  </span>
                </div>

                {frame >= 150 && frame < 250 ? (
                  // Typing indicator
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 4,
                      padding: "8px 0",
                    }}
                  >
                    {[typingDot1, typingDot2, typingDot3].map((opacity, i) => (
                      <div
                        key={i}
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: "50%",
                          backgroundColor: colors.primary,
                          opacity,
                        }}
                      />
                    ))}
                  </div>
                ) : frame >= 150 ? (
                  // Full response
                  <div
                    style={{
                      borderRadius: 12,
                      backgroundColor: colors.primary + "10",
                      border: `1px solid ${colors.primary}30`,
                      padding: 16,
                    }}
                  >
                    <p
                      style={{
                        fontSize: 15,
                        color: colors.foreground,
                        lineHeight: 1.5,
                        marginBottom: 12,
                      }}
                    >
                      {displayedAiText}
                    </p>
                    {aiTypedChars >= aiText.length && (
                      <div
                        style={{
                          backgroundColor: colors.background,
                          borderRadius: 8,
                          padding: 12,
                          border: `1px solid ${colors.border}`,
                        }}
                      >
                        <p
                          style={{
                            fontSize: 14,
                            fontWeight: 600,
                            color: colors.foreground,
                            marginBottom: 4,
                          }}
                        >
                          Subject: Meet your new AI-powered workspace
                        </p>
                        <p
                          style={{
                            fontSize: 13,
                            color: colors.mutedForeground,
                          }}
                        >
                          We&apos;re excited to introduce PageSpace—where your documents,
                          tasks, and conversations live alongside AI...
                        </p>
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          {/* Input Bar */}
          <div
            style={{
              padding: "12px 24px",
              borderTop: `1px solid ${colors.border}`,
              backgroundColor: colors.muted + "20",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                borderRadius: 10,
                border: `1px solid ${colors.border}`,
                backgroundColor: colors.background,
                padding: "10px 16px",
              }}
            >
              <span style={{ fontSize: 16, color: colors.mutedForeground }}>
                @
              </span>
              <span style={{ flex: 1, fontSize: 15, color: colors.mutedForeground }}>
                Message #product-launch
              </span>
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke={colors.mutedForeground}
                strokeWidth="2"
              >
                <path d="m22 2-7 20-4-9-9-4Z" />
                <path d="M22 2 11 13" />
              </svg>
            </div>
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
