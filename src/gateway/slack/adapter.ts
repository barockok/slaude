import type { AgentManager } from "../../agent/manager";
import { createGateway, type GatewayHandle, type GatewayOptions } from "../core/gateway";
import { createSlackTransport } from "./transport";
import type { Transport } from "../core/transport";

/** Build the production (bolt) gateway. Pass a custom transport to override
 *  the default Socket Mode transport (e.g. for webhook/HTTP mode). */
export function createSlackApp(agent: AgentManager, opts: GatewayOptions = {}, transport?: Transport): GatewayHandle {
  return createGateway(agent, transport ?? createSlackTransport(), opts);
}
