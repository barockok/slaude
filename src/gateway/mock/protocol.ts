import type { OutboundCard } from "../sim/transport";

export interface ServerInitPayload {
  type: "init";
  botUserId: string;
  botName: string;
  managerUserId: string;
  channel: string;
  cards: OutboundCard[];
}

export interface ServerCardPayload {
  type: "card";
  card: OutboundCard;
}

export interface ServerStatusPayload {
  type: "status";
  status: string | null;
}

export type ServerMessage = ServerInitPayload | ServerCardPayload | ServerStatusPayload;

export interface ClientMessagePayload {
  type: "message";
  text: string;
  user?: string;
  channel?: string;
}

export interface ClientActionPayload {
  type: "action";
  actionId: string;
  user?: string;
}

export type ClientMessage = ClientMessagePayload | ClientActionPayload;
