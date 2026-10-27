# Simulator captures

Real screens recorded off a simulator running the shipping build. App Review
guideline 2.3.3 requires screenshots show the app in actual use, so these are
what goes inside the device frame — never a mock.

One PNG per entry in `src/lib/app-store-shots.ts`, named by its `slug`:

```
iphone/   1320x2868   iPhone 6.9"   portrait
ipad/     2752x2064   iPad 13"      landscape
```

**iPad is landscape on purpose.** PageSpace is a three-pane product and portrait
squeezes it into something closer to a large phone. App Store Connect accepts
either orientation for 13" iPad provided the dimensions match the one you pick.

The five tell one story — ask, build, result, triggers, schedule — rather than
listing features. Only the first two or three show in App Store search results,
so keep the order.

Capture with the demo content loaded. The Simulator's own screenshot button
(⌘S) saves the image **as displayed**, already correctly oriented; `xcrun simctl
io … screenshot` grabs the raw framebuffer instead and needs `sips -r 90` on a
landscape device.

`bun run --cwd apps/marketing capture` fails if any capture is missing, and
asserts the exact output dimensions.
