import type { AgentManager } from "../../agent/manager";
import { createGateway, type GatewayHandle } from "../core/gateway";
import { createSlackTransport } from "./transport";

/** Back-compat entry: build the production (bolt) gateway. */
export function createSlackApp(agent: AgentManager): GatewayHandle {
  return createGateway(agent, createSlackTransport());
}
