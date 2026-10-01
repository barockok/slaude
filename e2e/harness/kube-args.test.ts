import { expect, test } from "bun:test";
import { assertE2eProfile, buildKubectlArgs, containerId, forwardedPort, parsePods, profileName } from "./kube-args";

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

test("the default profile is the e2e one", () => {
  expect(profileName({})).toBe("slaude-e2e");
  expect(profileName({ SLAUDE_LOCAL_PROFILE: "slaude-e2e-foo" })).toBe("slaude-e2e-foo");
  expect(buildKubectlArgs(["version"]).slice(0, 2)).toEqual(["--context", profileName()]);
});

test("profiles that are not e2e ones are refused", () => {
  expect(() => assertE2eProfile("slaude-local")).toThrow(/refusing profile 'slaude-local'/);
  expect(() => assertE2eProfile("")).toThrow(/refusing profile ''/);
  expect(() => assertE2eProfile("minikube")).toThrow(/slaude-e2e/);
  expect(() => profileName({ SLAUDE_LOCAL_PROFILE: "slaude-local" })).toThrow(/refusing/);
  expect(() => profileName({ SLAUDE_LOCAL_PROFILE: "" })).toThrow(/refusing/);
  expect(() => buildKubectlArgs(["get", "pod"], "slaude-local")).toThrow(/refusing/);
});

test("forwardedPort reads the local port for the requested remote port only", () => {
  const out = "Forwarding from 127.0.0.1:43111 -> 8080\nForwarding from [::1]:43111 -> 8080\n";
  expect(forwardedPort(out, 8080)).toBe(43111);
  expect(forwardedPort(out, 9090)).toBeNull();
  expect(forwardedPort("", 8080)).toBeNull();
  expect(forwardedPort("Forwarding from [::1]:50000 -> 80", 80)).toBe(50000);
  expect(forwardedPort("unable to listen on port 8080: address already in use", 8080)).toBeNull();
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
