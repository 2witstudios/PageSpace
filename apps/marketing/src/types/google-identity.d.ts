interface GoogleAccountsId {
  initialize(config: {
    client_id: string;
    login_uri?: string;
    callback?: (response: { credential: string }) => void;
    auto_select?: boolean;
    cancel_on_tap_outside?: boolean;
    context?: "signin" | "signup" | "use";
    ux_mode?: "popup" | "redirect";
    use_fedcm_for_prompt?: boolean;
    itp_support?: boolean;
  }): void;
  prompt(momentListener?: () => void): void;
  cancel(): void;
}

declare global {
  interface Window {
    google?: {
      accounts: {
        id: GoogleAccountsId;
      };
    };
  }
}

export {};
