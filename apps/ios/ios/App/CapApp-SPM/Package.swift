// swift-tools-version: 5.9
import PackageDescription

// DO NOT MODIFY THIS FILE - managed by Capacitor CLI commands
let package = Package(
    name: "CapApp-SPM",
    platforms: [.iOS(.v14)],
    products: [
        .library(
            name: "CapApp-SPM",
            targets: ["CapApp-SPM"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "7.6.5"),
        .package(name: "CapacitorApp", path: "../../../../../node_modules/.bun/@capacitor+app@7.1.2+abcf0b523ff3394e/node_modules/@capacitor/app"),
        .package(name: "CapacitorBrowser", path: "../../../../../node_modules/.bun/@capacitor+browser@7.0.5+abcf0b523ff3394e/node_modules/@capacitor/browser"),
        .package(name: "CapacitorKeyboard", path: "../../../../../node_modules/.bun/@capacitor+keyboard@7.0.6+abcf0b523ff3394e/node_modules/@capacitor/keyboard"),
        .package(name: "CapacitorPreferences", path: "../../../../../node_modules/.bun/@capacitor+preferences@7.0.4+abcf0b523ff3394e/node_modules/@capacitor/preferences"),
        .package(name: "CapacitorPushNotifications", path: "../../../../../node_modules/.bun/@capacitor+push-notifications@7.0.6+abcf0b523ff3394e/node_modules/@capacitor/push-notifications"),
        .package(name: "CapacitorSplashScreen", path: "../../../../../node_modules/.bun/@capacitor+splash-screen@7.0.5+abcf0b523ff3394e/node_modules/@capacitor/splash-screen"),
        .package(name: "CapacitorStatusBar", path: "../../../../../node_modules/.bun/@capacitor+status-bar@7.0.6+abcf0b523ff3394e/node_modules/@capacitor/status-bar"),
        .package(name: "CapgoCapacitorSocialLogin", path: "../../../../../node_modules/.bun/@capgo+capacitor-social-login@7.20.0+abcf0b523ff3394e/node_modules/@capgo/capacitor-social-login")
    ],
    targets: [
        .target(
            name: "CapApp-SPM",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "CapacitorApp", package: "CapacitorApp"),
                .product(name: "CapacitorBrowser", package: "CapacitorBrowser"),
                .product(name: "CapacitorKeyboard", package: "CapacitorKeyboard"),
                .product(name: "CapacitorPreferences", package: "CapacitorPreferences"),
                .product(name: "CapacitorPushNotifications", package: "CapacitorPushNotifications"),
                .product(name: "CapacitorSplashScreen", package: "CapacitorSplashScreen"),
                .product(name: "CapacitorStatusBar", package: "CapacitorStatusBar"),
                .product(name: "CapgoCapacitorSocialLogin", package: "CapgoCapacitorSocialLogin")
            ]
        )
    ]
)
