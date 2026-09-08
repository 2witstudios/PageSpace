# Simulator captures

Real screens recorded off a simulator running the shipping build. App Review
guideline 2.3.3 requires screenshots show the app in actual use, so these are
what goes inside the device frame — never a mock.

One PNG per entry in `src/lib/app-store-shots.ts`, named by its `slug`:

```
iphone/   1320x2868   iPhone 6.9"   (iPhone 16 Pro Max)
ipad/     2064x2752   iPad 13"
```

Record with the demo account signed in:

```bash
xcrun simctl io booted screenshot iphone/<slug>.png
```

`bun run --cwd apps/marketing capture` fails if any capture is missing.
