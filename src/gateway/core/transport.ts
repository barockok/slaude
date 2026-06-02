/** The subset of @slack/web-api WebClient that slaude actually calls. Methods are
 *  typed loosely so bolt's real client and the sim fake both satisfy it. */
export interface WebClientLike {
  auth: { test(args?: any): Promise<any> };
  chat: { postMessage(args: any): Promise<any>; update(args: any): Promise<any> };
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

export interface Transport {
  client: WebClientLike;
  action(idOrRegex: string | RegExp, h: ActionHandler): void;
  event(name: string, h: EventHandler): void;
  use(mw: Middleware): void;
  start(): Promise<any>;
  stop(): Promise<any>;
}
