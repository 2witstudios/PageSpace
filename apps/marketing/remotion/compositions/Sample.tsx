import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { DESIGN_TOKENS, Theme } from "../Root";

interface SampleCompositionProps {
  theme: Theme;
}

export const SampleComposition: React.FC<SampleCompositionProps> = ({
  theme,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const scale = spring({
    frame,
    fps,
    config: {
      damping: 200,
    },
  });

  const opacity = interpolate(frame, [0, 30], [0, 1], {
    extrapolateRight: "clamp",
  });

  const colors = {
    background:
      theme === "dark"
        ? DESIGN_TOKENS.colors.background.dark
        : DESIGN_TOKENS.colors.background.light,
    foreground:
      theme === "dark"
        ? DESIGN_TOKENS.colors.foreground.dark
        : DESIGN_TOKENS.colors.foreground.light,
    primary: DESIGN_TOKENS.colors.primary,
  };

  return (
    <AbsoluteFill
      className={theme}
      style={{
        backgroundColor: colors.background,
        justifyContent: "center",
        alignItems: "center",
        fontFamily: DESIGN_TOKENS.fonts.sans,
      }}
    >
      <div
        style={{
          opacity,
          transform: `scale(${scale})`,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 24,
        }}
      >
        {/* Logo */}
        <div
          style={{
            width: 80,
            height: 80,
            borderRadius: 16,
            backgroundColor: colors.primary,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <svg
            width="48"
            height="48"
            viewBox="0 0 24 24"
            fill="none"
            stroke="white"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
          </svg>
        </div>

        {/* Text */}
        <div
          style={{
            color: colors.foreground,
            fontSize: 72,
            fontWeight: 700,
            textAlign: "center",
          }}
        >
          PageSpace
        </div>

        <div
          style={{
            color:
              theme === "dark"
                ? DESIGN_TOKENS.colors.mutedForeground.dark
                : DESIGN_TOKENS.colors.mutedForeground.light,
            fontSize: 32,
            textAlign: "center",
          }}
        >
          AI-native workspace for teams
        </div>
      </div>
    </AbsoluteFill>
  );
};
