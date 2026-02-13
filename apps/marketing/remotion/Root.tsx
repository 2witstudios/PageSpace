import { Composition } from "remotion";
import { SampleComposition } from "./compositions/Sample";
import { HeroComposition } from "./compositions/Hero";
import "./styles.css";

// Shared design tokens
export const DESIGN_TOKENS = {
  colors: {
    primary: "hsl(221.2 83.2% 53.3%)",
    primaryForeground: "hsl(210 40% 98%)",
    background: {
      light: "hsl(0 0% 100%)",
      dark: "hsl(224 71% 4%)",
    },
    foreground: {
      light: "hsl(222.2 84% 4.9%)",
      dark: "hsl(210 40% 98%)",
    },
    muted: {
      light: "hsl(210 40% 96.1%)",
      dark: "hsl(217.2 32.6% 17.5%)",
    },
    mutedForeground: {
      light: "hsl(215.4 16.3% 46.9%)",
      dark: "hsl(215 20.2% 65.1%)",
    },
    border: {
      light: "hsl(214.3 31.8% 91.4%)",
      dark: "hsl(217.2 32.6% 17.5%)",
    },
  },
  fonts: {
    sans: "Geist, system-ui, sans-serif",
    mono: "Geist Mono, monospace",
  },
  // Standard video dimensions
  dimensions: {
    landscape: { width: 1920, height: 1080 },
    square: { width: 1080, height: 1080 },
    portrait: { width: 1080, height: 1920 },
    social: { width: 1200, height: 628 },
  },
};

export type Theme = "light" | "dark";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      {/* Sample Composition - for testing */}
      <Composition
        id="Sample"
        component={SampleComposition}
        durationInFrames={150}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{
          theme: "light" as const,
        }}
      />
      <Composition
        id="SampleDark"
        component={SampleComposition}
        durationInFrames={150}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{
          theme: "dark" as const,
        }}
      />

      {/* Hero Composition */}
      <Composition
        id="Hero"
        component={HeroComposition}
        durationInFrames={300}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{
          theme: "light" as const,
        }}
      />
      <Composition
        id="HeroDark"
        component={HeroComposition}
        durationInFrames={300}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{
          theme: "dark" as const,
        }}
      />
    </>
  );
};
