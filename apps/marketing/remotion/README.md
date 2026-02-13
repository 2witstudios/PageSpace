# Remotion Video System

This directory contains the Remotion video generation system for PageSpace marketing videos.

## Quick Start

### Start Remotion Studio (Development)

```bash
pnpm run remotion:studio
```

This opens the Remotion Studio where you can preview and develop compositions interactively.

### Render Videos

```bash
# Render all compositions (light and dark themes)
pnpm run remotion:render

# Render only light theme versions
pnpm run remotion:render:light

# Render only dark theme versions
pnpm run remotion:render:dark

# Render a specific composition
pnpm run remotion:render Hero
```

Rendered videos are output to `public/videos/`.

## Directory Structure

```
remotion/
├── Root.tsx              # Main entry point, registers all compositions
├── index.ts              # Remotion registration
├── styles.css            # Tailwind CSS for Remotion
├── compositions/
│   ├── Sample.tsx        # Test composition for verifying setup
│   └── Hero.tsx          # Hero section video for landing page
└── README.md             # This file
```

## Compositions

### Sample
- **Duration**: 5 seconds (150 frames @ 30fps)
- **Size**: 1920x1080 (16:9 landscape)
- **Purpose**: Test composition for verifying Remotion setup
- **IDs**: `Sample` (light), `SampleDark` (dark)

### Hero
- **Duration**: 10 seconds (300 frames @ 30fps)
- **Size**: 1920x1080 (16:9 landscape)
- **Purpose**: Hero section video showing app interface
- **IDs**: `Hero` (light), `HeroDark` (dark)

## Design Tokens

All compositions share design tokens defined in `Root.tsx`:

- Colors (primary, background, foreground, muted, border)
- Fonts (Geist Sans, Geist Mono)
- Standard dimensions (landscape, square, portrait, social)

## Theme Support

Each composition supports light and dark themes. The theme is passed as a prop and affects:
- Background colors
- Text colors
- Border colors
- UI element styling

## Adding New Compositions

1. Create a new file in `compositions/`
2. Define your component with `theme: Theme` prop
3. Register it in `Root.tsx` with both light and dark variants
4. Add it to the `COMPOSITIONS` array in `scripts/render-videos.ts`

Example:

```tsx
// compositions/NewComposition.tsx
import { AbsoluteFill } from "remotion";
import { DESIGN_TOKENS, Theme } from "../Root";

interface NewCompositionProps {
  theme: Theme;
}

export const NewComposition: React.FC<NewCompositionProps> = ({ theme }) => {
  return (
    <AbsoluteFill className={theme}>
      {/* Your content */}
    </AbsoluteFill>
  );
};
```

```tsx
// Root.tsx - Add to RemotionRoot
<Composition
  id="NewComposition"
  component={NewComposition}
  durationInFrames={150}
  fps={30}
  width={1920}
  height={1080}
  defaultProps={{ theme: "light" as const }}
/>
```

## Configuration

- `remotion.config.ts` - Remotion CLI configuration
- `tsconfig.remotion.json` - TypeScript config for Remotion files
