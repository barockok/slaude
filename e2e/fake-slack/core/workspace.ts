import { randomBytes } from "node:crypto";
import { TsClock } from "./clock";

export class SlackError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

export interface FakeUser {
  id: string;
  name: string;
  isBot: boolean;
}
export interface FakeChannel {
  id: string;
  name: string;
  isIm: boolean;
  members: Set<string>;
  topic: string;
  purpose: string;
}
export interface FakeApp {
  apiAppId: string;
  name: string;
  botUserId: string;
  botToken: string;
  signingSecret: string;
}
export interface FakeMessage {
  ts: string;
  channel: string;
  user: string;
  text: string;
  blocks?: unknown;
  threadTs?: string;
  appId?: string;
  deleted: boolean;
  edited: boolean;
  pinned: boolean;
  reactions: Map<string, Set<string>>;
}

/** An in-memory Slack workspace: users, apps, channels, messages, threads. */
export class Workspace {
  readonly users = new Map<string, FakeUser>();
  readonly channels = new Map<string, FakeChannel>();
  readonly apps = new Map<string, FakeApp>();
  readonly #messages = new Map<string, FakeMessage[]>();
  readonly #ephemerals: Array<{ channel: string; user: string; text: string; ts: string }> = [];
  readonly clock: TsClock;
  #botCount = 0;

  constructor(readonly teamId = "T0FAKE", clock: TsClock = new TsClock()) {
    this.clock = clock;
  }

  addUser(id: string, name: string, isBot = false): FakeUser {
    const u = { id, name, isBot };
    this.users.set(id, u);
    return u;
  }

  addApp(a: { apiAppId: string; name: string; botUserId?: string; botToken?: string; signingSecret?: string }): FakeApp {
    const botUserId = a.botUserId ?? `U0B${String(++this.#botCount).padStart(4, "0")}`;
    const app: FakeApp = {
      apiAppId: a.apiAppId,
      name: a.name,
      botUserId,
      // Built from parts so no literal token shape appears in source.
      botToken: a.botToken ?? `${"xoxb"}-fake-${randomBytes(12).toString("hex")}`,
      signingSecret: a.signingSecret ?? randomBytes(16).toString("hex"),
    };
    this.apps.set(app.apiAppId, app);
    this.addUser(botUserId, a.name, true);
    return app;
  }

  addChannel(c: { id: string; name: string; isIm?: boolean; members?: string[] }): FakeChannel {
    const ch: FakeChannel = {
      id: c.id,
      name: c.name,
      isIm: c.isIm ?? false,
      members: new Set(c.members ?? []),
      topic: "",
      purpose: "",
    };
    this.channels.set(ch.id, ch);
    this.#messages.set(ch.id, []);
    return ch;
  }

  appByToken(token: string): FakeApp | undefined {
    for (const app of this.apps.values()) if (app.botToken === token) return app;
    return undefined;
  }

  #channel(id: string): FakeChannel {
    const ch = this.channels.get(id);
    if (!ch) throw new SlackError("channel_not_found");
    return ch;
  }

  #find(channel: string, ts: string): FakeMessage {
    this.#channel(channel);
    const m = this.#messages.get(channel)!.find((x) => x.ts === ts && !x.deleted);
    if (!m) throw new SlackError("message_not_found");
    return m;
  }

  post(i: { channel: string; user: string; text: string; blocks?: unknown; threadTs?: string; appId?: string }): FakeMessage {
    this.#channel(i.channel);
    if (i.threadTs) {
      const parent = this.#messages.get(i.channel)!.find((x) => x.ts === i.threadTs && !x.deleted && !x.threadTs);
      if (!parent) throw new SlackError("thread_not_found");
    }
    const m: FakeMessage = {
      ts: this.clock.next(),
      channel: i.channel,
      user: i.user,
      text: i.text,
      blocks: i.blocks,
      threadTs: i.threadTs,
      appId: i.appId,
      deleted: false,
      edited: false,
      pinned: false,
      reactions: new Map(),
    };
    this.#messages.get(i.channel)!.push(m);
    return m;
  }

  update(channel: string, ts: string, patch: { text?: string; blocks?: unknown }): FakeMessage {
    const m = this.#find(channel, ts);
    if (patch.text !== undefined) m.text = patch.text;
    if (patch.blocks !== undefined) m.blocks = patch.blocks;
    m.edited = true;
    return m;
  }

  remove(channel: string, ts: string): void {
    this.#find(channel, ts).deleted = true;
  }

  message(channel: string, ts: string): FakeMessage | undefined {
    return this.#messages.get(channel)?.find((x) => x.ts === ts && !x.deleted);
  }

  /** Every live message in post order, replies included. */
  messages(channel: string): FakeMessage[] {
    this.#channel(channel);
    return this.#messages.get(channel)!.filter((m) => !m.deleted);
  }

  /** The root message followed by its replies in ts order (just the root if unthreaded). */
  replies(channel: string, ts: string): FakeMessage[] {
    const root = this.#messages.get(this.#channel(channel).id)!.find((x) => x.ts === ts && !x.deleted);
    if (!root) throw new SlackError("thread_not_found");
    const replies = this.#messages.get(channel)!.filter((x) => x.threadTs === ts && !x.deleted);
    return [root, ...replies];
  }

  react(channel: string, ts: string, name: string, user: string): void {
    const m = this.#find(channel, ts);
    const set = m.reactions.get(name) ?? new Set<string>();
    if (set.has(user)) throw new SlackError("already_reacted");
    set.add(user);
    m.reactions.set(name, set);
  }

  unreact(channel: string, ts: string, name: string, user: string): void {
    const m = this.#find(channel, ts);
    const set = m.reactions.get(name);
    if (!set?.delete(user)) throw new SlackError("no_reaction");
    if (set.size === 0) m.reactions.delete(name);
  }

  pin(channel: string, ts: string): void {
    const m = this.#find(channel, ts);
    if (m.pinned) throw new SlackError("already_pinned");
    m.pinned = true;
  }

  unpin(channel: string, ts: string): void {
    const m = this.#find(channel, ts);
    if (!m.pinned) throw new SlackError("not_pinned");
    m.pinned = false;
  }

  setTopic(channel: string, text: string): void {
    this.#channel(channel).topic = text;
  }

  setPurpose(channel: string, text: string): void {
    this.#channel(channel).purpose = text;
  }

  members(channel: string): string[] {
    return [...this.#channel(channel).members];
  }

  search(query: string): FakeMessage[] {
    const q = query.toLowerCase();
    const out: FakeMessage[] = [];
    for (const list of this.#messages.values()) for (const m of list) if (!m.deleted && m.text.toLowerCase().includes(q)) out.push(m);
    return out;
  }

  postEphemeral(channel: string, user: string, text: string): string {
    this.#channel(channel);
    const ts = this.clock.next();
    this.#ephemerals.push({ channel, user, text, ts });
    return ts;
  }

  ephemerals(): Array<{ channel: string; user: string; text: string; ts: string }> {
    return [...this.#ephemerals];
  }
}
