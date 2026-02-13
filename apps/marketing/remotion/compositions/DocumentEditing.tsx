import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
  Sequence,
} from "remotion";
import { DESIGN_TOKENS, Theme } from "../Root";

interface DocumentEditingProps {
  theme: Theme;
}

export const DocumentEditingComposition: React.FC<DocumentEditingProps> = ({
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

  // Animation phases
  const editorScale = spring({
    frame,
    fps,
    config: { damping: 200 },
  });

  // Typing animation - characters appear over time
  const userText = "The key to success is";
  const typedChars = Math.min(
    Math.floor(interpolate(frame, [30, 90], [0, userText.length])),
    userText.length
  );
  const displayedUserText = userText.slice(0, typedChars);

  // Cursor blink
  const cursorOpacity = Math.sin(frame * 0.3) > 0 ? 1 : 0;

  // AI suggestion appears
  const aiSuggestionOpacity = interpolate(frame, [100, 120], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const aiSuggestionScale = spring({
    frame: frame - 100,
    fps,
    config: { damping: 200 },
    durationInFrames: 30,
  });

  // AI typing its suggestion
  const aiText =
    " consistency. Small actions, repeated daily, compound into remarkable results.";
  const aiTypedChars = Math.min(
    Math.floor(interpolate(frame, [130, 250], [0, aiText.length])),
    aiText.length
  );
  const displayedAiText = aiText.slice(0, aiTypedChars);

  // Accept button pulse
  const acceptButtonScale = interpolate(
    frame,
    [260, 270, 280],
    [1, 1.05, 1],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    }
  );

  // Format toolbar highlight
  const formatHighlight = interpolate(frame, [15, 25], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

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
          maxWidth: 1200,
          transform: `scale(${editorScale})`,
        }}
      >
        {/* Document Editor */}
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
          {/* Editor Header */}
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
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke={colors.mutedForeground}
                strokeWidth="2"
              >
                <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
              <span
                style={{
                  fontSize: 16,
                  fontWeight: 500,
                  color: colors.foreground,
                }}
              >
                Building Habits That Stick.doc
              </span>
            </div>

            {/* Mode Toggle */}
            <div
              style={{
                display: "flex",
                borderRadius: 8,
                border: `1px solid ${colors.border}`,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  padding: "6px 12px",
                  fontSize: 13,
                  backgroundColor: colors.primary + "20",
                  color: colors.primary,
                  fontWeight: 500,
                }}
              >
                Rich Text
              </div>
              <div
                style={{
                  padding: "6px 12px",
                  fontSize: 13,
                  color: colors.mutedForeground,
                }}
              >
                Markdown
              </div>
            </div>
          </div>

          {/* Formatting Toolbar */}
          <Sequence from={0}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                padding: "12px 24px",
                borderBottom: `1px solid ${colors.border}`,
                backgroundColor: colors.muted + "20",
              }}
            >
              {["B", "I", "U"].map((format, i) => (
                <div
                  key={format}
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 6,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor:
                      i === 0 && formatHighlight > 0
                        ? colors.primary + Math.floor(formatHighlight * 30).toString(16)
                        : "transparent",
                    color:
                      i === 0 && formatHighlight > 0
                        ? colors.primary
                        : colors.mutedForeground,
                    fontSize: 14,
                    fontWeight: i === 0 ? 700 : i === 1 ? 400 : 400,
                    fontStyle: i === 1 ? "italic" : "normal",
                    textDecoration: i === 2 ? "underline" : "none",
                    transition: "all 0.2s",
                  }}
                >
                  {format}
                </div>
              ))}
              <div
                style={{
                  width: 1,
                  height: 20,
                  backgroundColor: colors.border,
                  margin: "0 8px",
                }}
              />
              {["H1", "H2", "H3"].map((heading) => (
                <div
                  key={heading}
                  style={{
                    padding: "6px 10px",
                    borderRadius: 6,
                    fontSize: 13,
                    color: colors.mutedForeground,
                  }}
                >
                  {heading}
                </div>
              ))}
              <div style={{ flex: 1 }} />
              <div
                style={{
                  padding: "6px 12px",
                  borderRadius: 6,
                  fontSize: 13,
                  backgroundColor: colors.primary + "15",
                  color: colors.primary,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
                </svg>
                AI Assist
              </div>
            </div>
          </Sequence>

          {/* Editor Content */}
          <div style={{ padding: "40px 60px", minHeight: 400 }}>
            {/* Title */}
            <h1
              style={{
                fontSize: 36,
                fontWeight: 700,
                color: colors.foreground,
                marginBottom: 24,
              }}
            >
              Building Habits That Stick
            </h1>

            {/* Existing paragraph */}
            <p
              style={{
                fontSize: 18,
                lineHeight: 1.7,
                color: colors.mutedForeground,
                marginBottom: 20,
              }}
            >
              We all want to improve ourselves, but most of us struggle to make
              lasting changes. Why do some habits stick while others fade away
              after a few weeks?
            </p>

            {/* Active paragraph with typing */}
            <div style={{ position: "relative" }}>
              <p
                style={{
                  fontSize: 18,
                  lineHeight: 1.7,
                  color: colors.foreground,
                  display: "inline",
                }}
              >
                {displayedUserText}
                <span
                  style={{
                    display: "inline-block",
                    width: 2,
                    height: 24,
                    backgroundColor: colors.primary,
                    marginLeft: 2,
                    opacity: typedChars < userText.length ? cursorOpacity : 0,
                    verticalAlign: "middle",
                  }}
                />
              </p>

              {/* AI Suggestion */}
              {frame >= 100 && (
                <span
                  style={{
                    display: "inline",
                    opacity: aiSuggestionOpacity,
                    transform: `scale(${aiSuggestionScale})`,
                  }}
                >
                  <span
                    style={{
                      color: colors.primary,
                      backgroundColor: colors.primary + "15",
                      borderRadius: 4,
                      padding: "2px 0",
                    }}
                  >
                    {displayedAiText}
                  </span>
                  {aiTypedChars >= aiText.length && (
                    <span
                      style={{
                        display: "inline-block",
                        width: 2,
                        height: 24,
                        backgroundColor: colors.primary,
                        marginLeft: 2,
                        opacity: cursorOpacity,
                        verticalAlign: "middle",
                      }}
                    />
                  )}
                </span>
              )}
            </div>

            {/* AI Suggestion Box */}
            {frame >= 120 && (
              <div
                style={{
                  marginTop: 24,
                  padding: 16,
                  borderRadius: 12,
                  backgroundColor: colors.primary + "10",
                  border: `1px solid ${colors.primary}30`,
                  opacity: aiSuggestionOpacity,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
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
                      style={{
                        fontSize: 14,
                        fontWeight: 500,
                        color: colors.primary,
                      }}
                    >
                      AI Suggestion
                    </span>
                  </div>

                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      style={{
                        padding: "6px 16px",
                        borderRadius: 6,
                        border: `1px solid ${colors.primary}`,
                        backgroundColor: colors.primary,
                        color: colors.primaryForeground,
                        fontSize: 13,
                        fontWeight: 500,
                        cursor: "pointer",
                        transform: `scale(${acceptButtonScale})`,
                      }}
                    >
                      Accept
                    </button>
                    <button
                      style={{
                        padding: "6px 16px",
                        borderRadius: 6,
                        border: `1px solid ${colors.border}`,
                        backgroundColor: "transparent",
                        color: colors.mutedForeground,
                        fontSize: 13,
                        cursor: "pointer",
                      }}
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Status Bar */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "12px 24px",
              borderTop: `1px solid ${colors.border}`,
              backgroundColor: colors.muted + "20",
              fontSize: 13,
              color: colors.mutedForeground,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
              <span>245 words</span>
              <span>•</span>
              <span>Saved</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
              </svg>
              <span>8 versions</span>
            </div>
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
