import type { AgentManager } from "../../agent/manager";
import { createGateway, type GatewayHandle, type GatewayOptions } from "../core/gateway";
import { createSlackTransport } from "./transport";

/** Back-compat entry: build the production (bolt) gateway. */
export function createSlackApp(agent: AgentManager, opts: GatewayOptions = {}): GatewayHandle {
  return createGateway(agent, createSlackTransport(), opts);
}
