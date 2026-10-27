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

declare module "@capacitor/push-notifications" {
  interface PluginListenerHandle {
    remove: () => Promise<void>;
  }

  interface PermissionStatus {
    receive: "prompt" | "prompt-with-rationale" | "granted" | "denied";
  }

  interface Token {
    value: string;
  }

  interface RegistrationError {
    error: string;
  }

  interface PushNotificationSchema {
    title?: string;
    subtitle?: string;
    body?: string;
    id: string;
    tag?: string;
    badge?: number;
    data: Record<string, unknown>;
    click_action?: string;
    link?: string;
    group?: string;
    groupSummary?: boolean;
  }

  interface ActionPerformed {
    actionId: string;
    inputValue?: string;
    notification: PushNotificationSchema;
  }

  export const PushNotifications: {
    checkPermissions(): Promise<PermissionStatus>;
    requestPermissions(): Promise<PermissionStatus>;
    register(): Promise<void>;
    unregister(): Promise<void>;
    getDeliveredNotifications(): Promise<{ notifications: PushNotificationSchema[] }>;
    removeDeliveredNotifications(options: { notifications: PushNotificationSchema[] }): Promise<void>;
    removeAllDeliveredNotifications(): Promise<void>;
    addListener(
      event: "registration",
      cb: (token: Token) => void
    ): Promise<PluginListenerHandle>;
    addListener(
      event: "registrationError",
      cb: (error: RegistrationError) => void
    ): Promise<PluginListenerHandle>;
    addListener(
      event: "pushNotificationReceived",
      cb: (notification: PushNotificationSchema) => void
    ): Promise<PluginListenerHandle>;
    addListener(
      event: "pushNotificationActionPerformed",
      cb: (action: ActionPerformed) => void
    ): Promise<PluginListenerHandle>;
  };
}
