/**
 * Ambient module declarations for Capacitor plugins that are only available
 * at runtime in the iOS/Android native shell. These packages are not npm
 * dependencies of the web app — they are dynamically imported with
 * webpackIgnore so the bundler skips them, and the native Capacitor runtime
 * resolves them at load time.
 */

declare module "@capacitor/keyboard" {
  interface KeyboardInfo {
    keyboardHeight: number;
  }

  interface PluginListenerHandle {
    remove: () => Promise<void>;
  }

  export const Keyboard: {
    addListener(
      event: "keyboardWillShow",
      cb: (info: KeyboardInfo) => void
    ): Promise<PluginListenerHandle>;
    addListener(
      event: "keyboardWillHide",
      cb: () => void
    ): Promise<PluginListenerHandle>;
  };
}

declare module "@capacitor/browser" {
  export const Browser: {
    open(options: { url: string }): Promise<void>;
  };
}
