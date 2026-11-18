import { afterAll } from "bun:test";
import { rmSync } from "node:fs";
import { LocalObjectStore, scratchStoreDir } from "../../src/storage";
import { runContract } from "./contract";

const dir = scratchStoreDir("local");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

runContract("LocalObjectStore", () => new LocalObjectStore(dir));
