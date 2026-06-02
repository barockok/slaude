export type CapturedCred =
  | { auth_strategy: "token"; token: string; refresh?: string }
  | { auth_strategy: "cookie"; storageState: string };

export type LoginSession = {
  loginId: string;
  liveViewUrl: string;
  expiresAt: number;
  /** Resolves when the user completes login and the cred is captured, or rejects on timeout/abandon. */
  done: Promise<CapturedCred>;
};

export interface LoginHost {
  /** Launch a confined login browser for a service; return the live-view session. */
  start(args: { service: string; slackUserId: string; loginUrl: string; authStrategy: "token" | "cookie" }): Promise<LoginSession>;
}
