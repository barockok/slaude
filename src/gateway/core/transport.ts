/** The subset of @slack/web-api WebClient that slaude actually calls. Methods are
 *  typed loosely so bolt's real client and the sim fake both satisfy it. */
export interface WebClientLike {
  auth: { test(args?: any): Promise<any> };
  chat: { postMessage(args: any): Promise<any>; update(args: any): Promise<any>; postEphemeral(args: any): Promise<any> };
  reactions: { add(args: any): Promise<any>; remove(args: any): Promise<any> };
  conversations: {
    info(args: any): Promise<any>;
    members(args: any): Promise<any>;
    replies(args: any): Promise<any>;
  };
  users: { info(args: any): Promise<any>; profile: { set(args: any): Promise<any> } };
  search: { messages(args: any): Promise<any> };
}

export type ActionHandler = (args: {
  ack: () => Promise<void>;
  action: { action_id: string };
  body: any;
  respond: (msg: any) => Promise<void>;
}) => Promise<void>;

export type EventHandler = (args: { event: any; client: WebClientLike; context: any }) => Promise<void>;
export type Middleware = (args: { payload: any; next: () => Promise<void> }) => Promise<void>;

/** Which registered Slack app an outbound call belongs to: the app an event,
 *  session, cron job or gate was created under (D1.2). Either part may be
 *  missing on rows written before the app was recorded. */
export type AppRef = { apiAppId?: string; teamId?: string };

/** One registered app, as listed for per-app boot diagnostics (D1.4). */
export type RegisteredApp = { apiAppId: string; teamId: string; botUserId?: string; client: WebClientLike };

export interface Transport {
  /** App-level client. Socket Mode: the one bot. HTTP mode: the oldest
   *  registered app; outbound calls must use clientFor() instead. */
  client: WebClientLike;
  /** HTTP mode (multi-app): the client of the app `app` names. Resolution
   *  happens per call, so a client may be held across a registry reload.
   *  Absent on single-app transports, where `client` is the only identity. */
  clientFor?(app: AppRef): WebClientLike;
  /** HTTP mode: the decrypted bot token of the app `app` names, or undefined
   *  when it cannot be identified unambiguously. */
  botTokenFor?(app: AppRef): string | undefined;
  /** HTTP mode: every registered app, once the registry has loaded. */
  apps?(): Promise<RegisteredApp[]>;
  action(idOrRegex: string | RegExp, h: ActionHandler): void;
  event(name: string, h: EventHandler): void;
  use(mw: Middleware): void;
  start(): Promise<any>;
  stop(): Promise<any>;
}

/** The client for `app`: per-app on a multi-app transport, the one client otherwise. */
export function clientForApp(t: Pick<Transport, "client" | "clientFor">, app?: AppRef): WebClientLike {
  return t.clientFor ? t.clientFor(app ?? {}) : t.client;
}
