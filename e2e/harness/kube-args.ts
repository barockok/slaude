// Pure helpers behind e2e/harness/kube.ts. They live apart so they can be unit
// tested (and counted by the repo-wide coverage threshold) without a cluster.

export const NAMESPACE = "slaude-scale";

/** The minikube profile and kube context of the e2e cluster. Never slaude-local. */
export function profileName(env: Record<string, string | undefined> = process.env): string {
  return env.SLAUDE_LOCAL_PROFILE || "slaude-e2e";
}

/** Prefix every kubectl call with the context and namespace, so none can hit another cluster. */
export function buildKubectlArgs(args: string[], profile: string = profileName()): string[] {
  return ["--context", profile, "-n", NAMESPACE, ...args];
}

export type Component = "gateway" | "node";

export interface PodInfo {
  name: string;
  ip: string;
}

/** Running pods of one slaude component from `kubectl get pod -o json`, sorted by name. */
export function parsePods(json: string, component: Component): PodInfo[] {
  const list = JSON.parse(json) as { items?: any[] };
  return (list.items ?? [])
    .filter((p) => p.metadata?.labels?.["app.kubernetes.io/component"] === component)
    .filter((p) => p.status?.phase === "Running" && !p.metadata?.deletionTimestamp)
    .map((p) => ({ name: p.metadata.name as string, ip: (p.status.podIP ?? "") as string }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** containerID of a named container from `kubectl get pod -o json`, without the runtime scheme. */
export function containerId(json: string, container: string): string | null {
  const pod = JSON.parse(json) as { status?: { containerStatuses?: any[] } };
  const id = pod.status?.containerStatuses?.find((c) => c.name === container)?.containerID as string | undefined;
  if (!id) return null;
  return id.includes("://") ? id.slice(id.indexOf("://") + 3) : id;
}
