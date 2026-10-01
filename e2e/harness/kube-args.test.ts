import { expect, test } from "bun:test";
import { buildKubectlArgs, containerId, parsePods, profileName } from "./kube-args";

const pod = (name: string, component: string, phase: string, ip: string, extra: object = {}) => ({
  metadata: { name, labels: { "app.kubernetes.io/component": component }, ...extra },
  status: { phase, podIP: ip },
});

const SAMPLE = JSON.stringify({
  items: [
    pod("slaude-node-b", "node", "Running", "10.0.0.4"),
    pod("slaude-gateway-b", "gateway", "Running", "10.0.0.2"),
    pod("slaude-gateway-a", "gateway", "Running", "10.0.0.1"),
    pod("slaude-gateway-c", "gateway", "Pending", ""),
    pod("slaude-gateway-d", "gateway", "Running", "10.0.0.9", { deletionTimestamp: "2026-10-01T00:00:00Z" }),
    { metadata: { name: "fake-slack-x", labels: {} }, status: { phase: "Running", podIP: "10.0.0.7" } },
  ],
});

test("kubectl args always carry the context and namespace first", () => {
  expect(buildKubectlArgs(["get", "pod"], "slaude-e2e")).toEqual(["--context", "slaude-e2e", "-n", "slaude-scale", "get", "pod"]);
});

test("the default profile is the e2e one and never slaude-local", () => {
  expect(profileName({})).toBe("slaude-e2e");
  expect(profileName({ SLAUDE_LOCAL_PROFILE: "" })).toBe("slaude-e2e");
  expect(profileName({ SLAUDE_LOCAL_PROFILE: "other" })).toBe("other");
  expect(buildKubectlArgs(["version"]).slice(0, 2)).toEqual(["--context", profileName()]);
});

test("parsePods keeps running pods of the component, sorted, with their IPs", () => {
  expect(parsePods(SAMPLE, "gateway")).toEqual([
    { name: "slaude-gateway-a", ip: "10.0.0.1" },
    { name: "slaude-gateway-b", ip: "10.0.0.2" },
  ]);
  expect(parsePods(SAMPLE, "node")).toEqual([{ name: "slaude-node-b", ip: "10.0.0.4" }]);
});

test("parsePods tolerates an empty list and a missing IP", () => {
  expect(parsePods("{}", "node")).toEqual([]);
  const noIp = JSON.stringify({ items: [{ metadata: { name: "n", labels: { "app.kubernetes.io/component": "node" } }, status: { phase: "Running" } }] });
  expect(parsePods(noIp, "node")).toEqual([{ name: "n", ip: "" }]);
});

test("containerId strips the runtime scheme and returns null when absent", () => {
  const j = JSON.stringify({ status: { containerStatuses: [{ name: "gateway", containerID: "docker://abc123" }, { name: "side", containerID: "raw456" }, { name: "wait" }] } });
  expect(containerId(j, "gateway")).toBe("abc123");
  expect(containerId(j, "side")).toBe("raw456");
  expect(containerId(j, "wait")).toBeNull();
  expect(containerId(j, "nope")).toBeNull();
  expect(containerId("{}", "gateway")).toBeNull();
});
