import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";
import betterTailwind from "eslint-plugin-better-tailwindcss";
import { getDefaultSelectors } from "eslint-plugin-better-tailwindcss/defaults";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

// The token lock's source of truth: better-tailwindcss resolves classes
// against this stylesheet, so a default-theme class is unknown here.
const entryPoint = join(__dirname, "src/app/globals.css");

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@pagespace/db",
              message:
                "Use subpath imports: @pagespace/db/db, @pagespace/db/operators, or @pagespace/db/schema/<name>",
            },
            {
              name: "@pagespace/lib",
              message:
                "Use a specific subpath import e.g. @pagespace/lib/auth/session-service",
            },
          ],
        },
      ],
    },
  },
  // Token-locked Tailwind (ADR 0007, from myimago's ADR 0028): classes must
  // come from the imago theme in globals.css. Arbitrary values and
  // properties, per-element dark/color-scheme variants, unknown, conflicting
  // and duplicate classes fail here.
  {
    files: ["src/**/*.tsx", "src/**/*-class.ts"],
    // Retained feature JSX is checked against its separately scoped classic
    // stylesheet. The Imago shell keeps the original strict token lock.
    ignores: ["src/retained/**", "src/retained-adapters/**"],
    plugins: { "better-tailwindcss": betterTailwind },
    settings: { "better-tailwindcss": { entryPoint } },
    rules: {
      "better-tailwindcss/no-unknown-classes": "error",
      "better-tailwindcss/no-conflicting-classes": "error",
      "better-tailwindcss/no-duplicate-classes": "error",
      "better-tailwindcss/no-restricted-classes": [
        "error",
        {
          restrict: [
            {
              pattern: "\\[",
              message:
                "Arbitrary values and properties bypass the design tokens; add a token to the theme instead.",
            },
            {
              // Any variant ending in dark (dark:, not-dark:, group-dark:)
              // or naming a color scheme.
              pattern: "(^|[:-])(dark|scheme-[a-z-]+):",
              message:
                "Theme colors come from light-dark() tokens; do not add per-element color-scheme variants.",
            },
            {
              pattern: "^scheme-",
              message: "color-scheme is owned by <html data-theme> in globals.css.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/retained/**/*.tsx", "src/retained-adapters/**/*.tsx"],
    plugins: { "better-tailwindcss": betterTailwind },
    settings: { "better-tailwindcss": { entryPoint: join(__dirname, "src/retained-adapters/retained.source.css") } },
    rules: {
      // Literal custom CSS selectors / semantic markers in the retained styles,
      // plus a type-index string the analyzer sees inside a cn() expression.
      "better-tailwindcss/no-unknown-classes": ["error", { ignore: ["^(dark|prose-xs|prose-red|find-highlight|find-highlight-current|not-prose|print-page-number|breadcrumb|editor-readonly|middle-section-scroll|holographic-card|liquid-glass-thin|toaster|status)$"] }],
      "better-tailwindcss/no-duplicate-classes": "error",
    },
  },
  // Variant class modules hold nothing but class strings, under whatever
  // variable names read best (`base`, `tones`, `sizes`), so every string and
  // object value in them is checked, not only the default `className` names.
  {
    files: ["src/**/*-class.ts"],
    settings: {
      "better-tailwindcss": {
        entryPoint,
        selectors: [
          ...getDefaultSelectors(),
          {
            kind: "variable",
            name: ".*",
            match: [{ type: "strings" }, { type: "objectValues" }],
          },
        ],
      },
    },
  },
];

export default eslintConfig;
