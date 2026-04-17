# PageSpace iOS — Native Dependency Inventory (Swift Package Manager)

**Prepared:** 2026-04-17
**Scope:** Direct Swift Package Manager pins consumed by `apps/ios` as of commit `cca2d7572d3a7c7abf87dec3b2a557c80c37ed2b`.
**Source of truth:** `apps/ios/ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved`

Note: iOS uses Swift Package Manager (SPM), not CocoaPods. There is no Podfile in this repository. The inventory below is generated from the SPM `Package.resolved` lockfile and each upstream repository's `LICENSE` file was retrieved and inspected to confirm the license identifier — no identifier is inferred from the organization name.

## Inventory

| Package | Version | License | Upstream |
|---|---|---|---|
| Alamofire | 5.11.0 | MIT | https://github.com/Alamofire/Alamofire |
| app-check | 11.2.0 | Apache-2.0 | https://github.com/google/app-check |
| AppAuth-iOS | 2.0.0 | Apache-2.0 | https://github.com/openid/AppAuth-iOS |
| capacitor-swift-pm | 7.4.5 | MIT | https://github.com/ionic-team/capacitor-swift-pm |
| facebook-ios-sdk | 18.0.2 | Facebook Platform License (custom, non-SPDX) [¹](#note-1) | https://github.com/facebook/facebook-ios-sdk |
| GoogleSignIn-iOS | 9.1.0 | Apache-2.0 | https://github.com/google/GoogleSignIn-iOS |
| GoogleUtilities | 8.1.0 | Apache-2.0 | https://github.com/google/GoogleUtilities |
| gtm-session-fetcher | 3.5.0 | Apache-2.0 | https://github.com/google/gtm-session-fetcher |
| GTMAppAuth | 5.0.0 | Apache-2.0 | https://github.com/google/GTMAppAuth |
| Promises | 2.4.0 | Apache-2.0 | https://github.com/google/promises |

## Notes

<a id="note-1"></a>
**[¹] Facebook iOS SDK license — not MIT.** The `LICENSE` file in `github.com/facebook/facebook-ios-sdk` at tag `v18.0.2` is not a standard SPDX license. It is a custom permissive license (hereinafter "Facebook Platform License") that grants a non-exclusive, worldwide, royalty-free license to use, copy, modify, and distribute the software **"for use in connection with the web services and APIs provided by Facebook"** — a scope restriction that the SPDX MIT license does not contain. The license further states that use is subject to the Facebook Platform Policy at `http://developers.facebook.com/policy/`. The full verbatim text is reproduced below for the avoidance of doubt; it is also available at `https://raw.githubusercontent.com/facebook/facebook-ios-sdk/v18.0.2/LICENSE`:

> Copyright (c) Meta Platforms, Inc. and affiliates. All rights reserved.
>
> You are hereby granted a non-exclusive, worldwide, royalty-free license to use, copy, modify, and distribute this software in source code or binary form for use in connection with the web services and APIs provided by Facebook.
>
> As with any software that integrates with the Facebook platform, your use of this software is subject to the Facebook Platform Policy [http://developers.facebook.com/policy/]. This copyright notice shall be included in all copies or substantial portions of the software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

This SDK license governs the SDK code itself. It is distinct from the separate Meta / Facebook platform developer terms that govern runtime API usage; the two are independent legal instruments and both apply to any product integrating the SDK.

**Transitive SPM dependencies.** The table above enumerates the direct pins recorded in `Package.resolved`. The full transitive SPM dependency tree is regenerable on demand via Xcode's `File > Packages > Resolve Package Versions` (which rewrites `Package.resolved`), or via `xcodebuild -resolvePackageDependencies` from the command line. The transitive tree is not separately enumerated in this inventory because SPM resolves it deterministically from the direct pins and the packages' own `Package.swift` manifests.

**Apple SDK frameworks.** Apple's own iOS SDK frameworks (UIKit, Foundation, WebKit, etc.) are linked at build time under Apple's Xcode / SDK License Agreement and are not SPM pins; they are therefore out of scope for this inventory.

## Regeneration

To reproduce this inventory:

```bash
# 1) Show the resolved pins:
cat apps/ios/ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved

# 2) For each pin, fetch the upstream LICENSE file (identity and state.version are in
#    the JSON above). Tries `main` first, then falls back to `master`, since both
#    conventions are in use across these repositories:
for repo in Alamofire/Alamofire google/app-check openid/AppAuth-iOS \
           ionic-team/capacitor-swift-pm facebook/facebook-ios-sdk \
           google/GoogleSignIn-iOS google/GoogleUtilities \
           google/gtm-session-fetcher google/GTMAppAuth google/promises; do
  echo "--- $repo"
  curl -sfL "https://raw.githubusercontent.com/$repo/main/LICENSE" 2>/dev/null | head -5 \
    || curl -sfL "https://raw.githubusercontent.com/$repo/master/LICENSE" 2>/dev/null | head -5 \
    || echo "(no LICENSE at standard paths — check repo)"
  echo
done

# 3) For facebook-ios-sdk specifically, pin the fetch to the exact SPM-resolved tag
#    to confirm the license text at v18.0.2 rather than the moving branch tip:
curl -sfL "https://raw.githubusercontent.com/facebook/facebook-ios-sdk/v18.0.2/LICENSE"
```
