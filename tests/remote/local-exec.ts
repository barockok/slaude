import { spawn } from "node:child_process";
import { PGRP_MARKER, wrapCommand } from "../../src/remote/shell";
import type { Exec } from "../../src/remote/types";

/** Runs remote command strings on this machine: same wrapper, same parsing. */
export const localExec: Exec = (cmd, opts) =>
  new Promise((resolve) => {
    const p = spawn("/bin/sh", ["-c", wrapCommand(cmd, !!opts.login)], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "", timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      // Like the real client: take down the command's whole process group, else
      // an orphaned child keeps the pipes open until it exits on its own.
      const pgid = err.match(new RegExp(`${PGRP_MARKER}(\\d+)`))?.[1];
      try { if (pgid) process.kill(-Number(pgid), "SIGKILL"); } catch {}
      p.kill("SIGKILL");
    }, opts.timeoutMs);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => {
      clearTimeout(t);
      resolve({ stdout: out, stderr: err.replace(new RegExp(`${PGRP_MARKER}\\d+\\n`), ""), code: timedOut ? null : code, truncated: false, timedOut });
    });
    p.stdin.end(opts.stdin ?? "");
  });
