#!/usr/bin/env python3
"""Summarise results/02-bench.*.tsv into markdown tables: median ms per workload per configuration,
ratio against C0, and the K2a-K2d verdicts. Usage: python3 02-summary.py [results-dir]"""
import glob, os, statistics, sys, collections

d = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "results")
data = collections.defaultdict(lambda: collections.defaultdict(list))
failed = collections.defaultdict(lambda: collections.defaultdict(int))
notrun = {}
for f in sorted(glob.glob(os.path.join(d, "02-bench.*.tsv"))):
    for line in open(f):
        p = line.rstrip("\n").split("\t")
        if len(p) == 1 and "not-run" in line:
            notrun[line.split()[0]] = line.strip()
            continue
        if len(p) < 5:
            continue
        cfg, w, run, ms, rc = p[:5]
        if rc == "0":
            data[w][cfg].append(int(ms))
        else:
            failed[w][cfg] += 1
cfgs = [c for c in ["C0", "C1", "C2", "C3", "C4", "C5"] if any(c in data[w] for w in data) or c in notrun]
order = ["clone", "git-status", "git-log100", "git-checkout", "rg", "bun-install-warm", "npm-ci-warm", "pip-venv-numpy", "bun-test-tiny", "many-files-create", "many-files-find", "many-files-delete", "toolchain-python-imports", "toolchain-node-builtins", "toolchain-claude-version", "cli-boot-plain-turn", "agent-turn-10-tools", "go-build-xtools"]
print("Median wall time in ms (runs in brackets; first run follows a host page-cache drop). A cell marked fail:n had n failed runs.\n")
print("| workload | " + " | ".join(cfgs) + " |")
print("|---|" + "---|" * len(cfgs))
med = {}
for w in order:
    row = []
    for c in cfgs:
        v = data[w].get(c, [])
        if not v:
            row.append("not run" if c in notrun else (f"fail:{failed[w][c]}" if failed[w][c] else "-"))
            continue
        med[(w, c)] = statistics.median(v)
        row.append(f"{int(statistics.median(v))} ({'/'.join(str(x) for x in v)})" + (f" fail:{failed[w][c]}" if failed[w][c] else ""))
    print(f"| {w} | " + " | ".join(row) + " |")
print("\nRatio against C0 (median):\n")
print("| workload | " + " | ".join(c for c in cfgs if c != "C0") + " |")
print("|---|" + "---|" * (len(cfgs) - 1))
for w in order:
    if (w, "C0") not in med:
        continue
    row = []
    for c in cfgs:
        if c == "C0":
            continue
        row.append(f"{med[(w, c)] / med[(w, 'C0')]:.2f}x ({int(med[(w, c)] - med[(w, 'C0')]):+d} ms)" if (w, c) in med else "-")
    print(f"| {w} | " + " | ".join(row) + " |")


def verdict(c):
    out = []
    def r(w):
        return (med.get((w, c)), med.get((w, "C0")))
    a, b = r("bun-install-warm")
    if a and b:
        out.append(f"K2a bun install warm: {a/b:.2f}x, {int(a-b)} ms slower -> " + ("KILL" if a > 3 * b and a - b > 20000 else "pass"))
    a, b = r("git-status")
    if a and b:
        out.append(f"K2b git status: {a/b:.2f}x, {int(a-b)} ms slower -> " + ("KILL" if a > 5 * b and a - b > 2000 else "pass"))
    a, b = r("agent-turn-10-tools")
    if a and b:
        out.append(f"K2c scripted agent turn: {a/b:.2f}x, {int(a-b)} ms -> " + ("KILL" if a > 1.25 * b else "pass"))
    a, b = r("cli-boot-plain-turn")
    if a and b:
        out.append(f"K2d CLI boot (plain turn): {int(a-b)} ms slower -> " + ("KILL" if a - b > 3000 else "pass"))
    return out


print("\nKill criteria per configuration (K2a to K2d, against C0):\n")
for c in cfgs:
    if c == "C0":
        continue
    print(f"- {c}: " + ("; ".join(verdict(c)) if verdict(c) else notrun.get(c, "no data")))
