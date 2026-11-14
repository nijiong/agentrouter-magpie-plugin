import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initialize, runOnce, status } from "../src/local-checkin.mjs";
import { pathToFileURL } from "node:url";
import { withFetch } from "./helpers/fetch.mjs";
import { copyRuntimeModules } from "./helpers/runtime.mjs";

for (const scenario of [
  { name: "server confirms a new reward", marker: true, outcome: "claimed", paused: false },
  { name: "no new reward is not reported as claimed", marker: false, outcome: "done", paused: false },
  { name: "a completed login checks in without a reward marker", outcome: "done", paused: false },
  { name: "captcha HTML pauses without browser fallback", html: true, outcome: "failed", paused: true },
]) {
  test("local default hook: " + scenario.name, async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "ar-local-integration-"));
    const previousFetch = globalThis.fetch;
    const calls = [];
    try {
      await initialize(home);
      await fs.writeFile(path.join(home, "config.json"), JSON.stringify({ version: 1, site: "air", userId: "42" }));
      await fs.writeFile(path.join(home, "credentials.txt"), "offline-user:offline-test-only");
      globalThis.fetch = async (input, options) => {
        const url = new URL(input);
        const headers = new Headers(options.headers);
        calls.push(url.origin + url.pathname);
        assert.equal(url.origin, "https://ps.air-outer.com");
        assert.equal(url.pathname, "/api/user/login");
        assert.equal(options.method, "POST");
        assert.equal(headers.has("authorization"), false);
        assert.equal(headers.has("cookie"), false);
        assert.deepEqual(JSON.parse(options.body), { username: "offline-user", password: "offline-test-only" });
        if (scenario.html) return new Response("<!doctype html><html>captcha</html>", { headers: { "content-type": "text/html" } });
        return Response.json({ success: true, data: { id: 42, checked_in: scenario.marker } });
      };
      const now = () => 1_800_000_000_000;
      const first = await runOnce(home, { now });
      assert.equal(first.outcome, scenario.outcome);
      const state = await status(home);
      assert.equal(state.paused, scenario.paused);
      const count = calls.length;
      assert.equal(count, 1);
      const second = await runOnce(home, { now });
      assert.equal(second.outcome, scenario.paused ? "paused" : "skipped");
      assert.equal(calls.length, count);
      const persisted = await fs.readFile(path.join(home, "state.json"), "utf8");
      assert.doesNotMatch(persisted, /offline-test-only|offline-user/);
    } finally {
      globalThis.fetch = previousFetch;
      assert.equal(path.dirname(home), os.tmpdir());
      await fs.rm(home, { recursive: true, force: true });
    }
  });
}

test("local default checkin runs without the host plugin entry and keeps its cooldown", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ar-standalone-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ar-standalone-home-"));
  try {
    const source = path.join(root, "src");
    await fs.mkdir(source);
    await copyRuntimeModules(source);
    await fs.rm(path.join(source, "index.mjs"));
    const { runOnce: standaloneRun } = await import(pathToFileURL(path.join(source, "local-checkin.mjs")).href);
    await initialize(home);
    await fs.writeFile(path.join(home, "config.json"), JSON.stringify({ version: 1, site: "air", userId: "42" }));
    await fs.writeFile(path.join(home, "credentials.txt"), "offline-user:offline-only");
    await withFetch([({ url, init }) => {
      assert.equal(url.href, "https://ps.air-outer.com/api/user/login");
      assert.deepEqual(JSON.parse(init.body), { username: "offline-user", password: "offline-only" });
      return Response.json({ success: true, data: { id: 42, checked_in: true } });
    }], async calls => {
      const now = () => 1_800_000_000_000;
      assert.equal((await standaloneRun(home, { now })).outcome, "claimed");
      assert.equal((await standaloneRun(home, { now })).outcome, "skipped");
      assert.equal(calls.length, 1);
    });
  } finally {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
});

for (const initial of ["claimed", "failed"]) {
  test("resume preserves 24h gate after " + initial, async () => {
    const { resume } = await import("../src/local-checkin.mjs");
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "ar-local-recovery-"));
    try {
      await initialize(home);
      await fs.writeFile(path.join(home, "config.json"), JSON.stringify({ version: 1, site: "air", userId: "42" }));
      await fs.writeFile(path.join(home, "credentials.txt"), "offline-user:offline-only");
      const at = 1_800_000_000_000;
      await runOnce(home, { now: () => at, checkin: async () => ({ outcome: initial }) });
      await resume(home);
      let calls = 0;
      const result = await runOnce(home, { now: () => at + 1000, checkin: async () => { calls++; return { outcome: "claimed" }; } });
      assert.equal(result.outcome, "skipped");
      assert.equal(calls, 0);
      assert.equal((await status(home)).nextAttemptAt, at + 86_400_000);
    } finally { await fs.rm(home, { recursive: true, force: true }); }
  });
}

test("local secrets cannot be initialized in a different Git repository", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ar-other-repo-"));
  try {
    await fs.mkdir(path.join(root, ".git"));
    await assert.rejects(initialize(path.join(root, "private")));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("no automatic stale-lock deletion API is exposed", async () => {
  const module = await import("../src/local-checkin.mjs");
  assert.equal("unlock" in module, false);
});

test("replacement lock is never deleted by an older owner", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ar-lock-owner-"));
  try {
    await initialize(home);
    await fs.writeFile(path.join(home, "config.json"), JSON.stringify({ version: 1, site: "air", userId: "42" }));
    await fs.writeFile(path.join(home, "credentials.txt"), "offline-user:offline-only");
    const replacement = JSON.stringify({ pid: process.pid, token: "replacement-owner" });
    await assert.rejects(runOnce(home, { checkin: async () => {
      await fs.writeFile(path.join(home, "run.lock"), replacement);
      return { outcome: "claimed" };
    } }));
    assert.equal(await fs.readFile(path.join(home, "run.lock"), "utf8"), replacement);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test("Windows broad credential ACL is rejected before checkin", { skip: process.platform !== "win32" }, async () => {
  const { promisify } = await import("node:util");
  const { execFile } = await import("node:child_process");
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ar-acl-denied-"));
  try {
    await initialize(home);
    await fs.writeFile(path.join(home, "config.json"), JSON.stringify({ version: 1, site: "air", userId: "42" }));
    await fs.writeFile(path.join(home, "credentials.txt"), "offline-user:offline-only");
    await promisify(execFile)(path.join(process.env.SystemRoot || "C:/Windows", "System32", "icacls.exe"), [path.join(home, "credentials.txt"), "/grant", "*S-1-5-11:R"]);
    let called = false;
    await assert.rejects(runOnce(home, { checkin: async () => { called = true; return { outcome: "claimed" }; } }));
    assert.equal(called, false);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test("watch checks locally and performs only due attempts with a simulated clock", async () => {
  const { watch } = await import("../src/local-checkin.mjs");
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ar-watch-"));
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  try {
    await initialize(home);
    await fs.writeFile(path.join(home, "config.json"), JSON.stringify({ version: 1, site: "air", userId: "42" }));
    await fs.writeFile(path.join(home, "credentials.txt"), "offline-user:offline-only");
    let time = 1_800_000_000_000;
    Date.now = () => time;
    let requests = 0;
    globalThis.fetch = async () => {
      requests++;
      return Response.json({ success: true, data: { id: 42, checked_in: true } });
    };
    const stop = new AbortController();
    const events = [];
    let polls = 0;
    await watch(home, {
      signal: stop.signal,
      report: result => { events.push(result.outcome); if (events.filter(x => x === "claimed").length === 2) stop.abort(); },
      poll: async ms => { assert.equal(ms, 60_000); time += polls++ === 0 ? 60_000 : 86_400_000; },
    });
    assert.deepEqual(events, ["claimed", "skipped", "claimed"]);
    assert.equal(requests, 2);
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("a parent junction cannot redirect local credential storage into a repository", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ar-parent-junction-"));
  try {
    const repository = path.join(root, "repository");
    const alias = path.join(root, "alias");
    await fs.mkdir(repository);
    await fs.mkdir(path.join(repository, ".git"));
    await fs.symlink(repository, alias, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(initialize(path.join(alias, "private")));
    await assert.rejects(fs.access(path.join(repository, "private", "credentials.txt")));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("Linux and Windows reject shared home permissions before network access", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ar-home-permissions-"));
  let calls = 0;
  try {
    await initialize(home);
    await status(home);
    if (process.platform === "win32") {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const icacls = path.join(process.env.SystemRoot || "C:/Windows", "System32", "icacls.exe");
      await promisify(execFile)(icacls, [home, "/grant", "*S-1-5-32-545:(OI)(CI)R"], { windowsHide: true });
    } else {
      assert.equal((await fs.stat(home)).mode & 0o777, 0o700);
      for (const file of ["config.json", "credentials.txt"]) {
        assert.equal((await fs.stat(path.join(home, file))).mode & 0o777, 0o600);
      }
      await fs.chmod(home, 0o755);
    }
    const expected = process.platform === "win32" ? "UNSAFE_WINDOWS_PERMISSIONS" : "UNSAFE_HOME_PERMISSIONS";
    await assert.rejects(status(home), { code: expected });
    await assert.rejects(runOnce(home, { checkin: async () => { calls++; } }), { code: expected });
    assert.equal(calls, 0);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});
