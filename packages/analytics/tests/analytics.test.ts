import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AnonIdentity, base32, deriveAnonId, newSecret } from "../src/anon.js";
import { AnalyticsEvent, Batch, checkSemantics, parseEvent } from "../src/events.js";
import { FEATURES, FEATURE_REGISTRY_VERSION, dimAllowed, featureById, isCounted, featureIds, registrySnapshot } from "../src/features.js";
import { EventQueue } from "../src/queue.js";
import { Tracker, type HostSignals, type SessionDraft } from "../src/tracker.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-analytics-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

class FakeClock {
  t = 1_792_747_832_000;
  m = 0;
  wall = () => this.t;
  mono = () => this.m;
  advance(ms: number) {
    this.t += ms;
    this.m += ms;
  }
}

class FakeHost implements HostSignals {
  focused = true;
  idle = 0;
  isFocused = () => this.focused;
  idleMs = () => this.idle;
  on() {
    return () => {};
  }
}

function recorder() {
  const events: { featureId: string; action: string; dim: string | null; ts: number }[] = [];
  const sessions: SessionDraft[] = [];
  return {
    events,
    sessions,
    out: {
      activate: (featureId: string, action: string, dim: string | null, ts: number) => events.push({ featureId, action, dim, ts }),
      session: (draft: SessionDraft) => sessions.push(draft)
    }
  };
}

function setup() {
  const clock = new FakeClock();
  const host = new FakeHost();
  const rec = recorder();
  let enabled = true;
  const tracker = new Tracker(host, rec.out, { clock, enabled: () => enabled });
  return { clock, host, rec, tracker, setEnabled: (v: boolean) => (enabled = v) };
}

describe("feature registry", () => {
  it("has unique, well-formed ids and actions the events can name", () => {
    const ids = featureIds();
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*){0,2}$/);
    for (const feature of FEATURES) {
      if (feature.id === "backlog.lane") expect(feature.timedIn).toBe("backlog.board");
      expect(feature.sinceRegistry).toBeLessThanOrEqual(FEATURE_REGISTRY_VERSION);
      expect(feature.actions.length).toBeGreaterThan(0);
      for (const action of feature.actions) expect(action.name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
    expect(featureIds()).toHaveLength(26);
    expect(isCounted("backlog.create", "create")).toBe(true);
    expect(isCounted("backlog.board", "open")).toBe(true);
    expect(dimAllowed(featureById("backlog.create")!, "quick")).toBe(true);
    expect(dimAllowed(featureById("backlog.create")!, "paste")).toBe(false);
    expect(dimAllowed(featureById("agent.chat")!, "acp-antigravity")).toBe(true);
    expect(dimAllowed(featureById("backlog.board")!, "anything")).toBe(false);
    expect(registrySnapshot().version).toBe(FEATURE_REGISTRY_VERSION);
  });
});

describe("anonymous identity", () => {
  it("is stable within a rotation epoch, changes across it, and survives a restart", () => {
    const root = fs.mkdtempSync(path.join(dir, "anon-"));
    let now = 1_700_000_000_000;
    const identity = new AnonIdentity(root, () => now);
    const first = identity.current();
    expect(first).toMatch(/^[a-z2-7]{26}$/);
    expect(identity.current()).toBe(first);
    expect(identity.nextSeq()).toBe(1);
    expect(identity.nextSeq()).toBe(2);

    const reopened = new AnonIdentity(root, () => now);
    expect(reopened.current()).toBe(first);
    expect(reopened.nextSeq()).toBe(3);

    now += 366 * 24 * 60 * 60_000;
    expect(identity.current()).not.toBe(first);
    expect(identity.nextSeq()).toBe(1);

    const beforeReset = identity.current();
    const reset = identity.reset();
    expect(reset.anonId).not.toBe(beforeReset);
    expect(identity.current()).toBe(reset.anonId);
    expect(identity.nextSeq()).toBe(1);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("keeps the secret local and never serialises it", () => {
    const root = fs.mkdtempSync(path.join(dir, "anon-"));
    const identity = new AnonIdentity(root, () => 1_700_000_000_000);
    const info = identity.info();
    expect(JSON.stringify(info)).not.toContain(fs.readFileSync(identity.secretFile, "utf8"));
    expect(fs.statSync(identity.secretFile).mode & 0o777).toBe(0o600);
    identity.clear();
    expect(fs.existsSync(identity.secretFile)).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("encodes 16 bytes into 26 base32 characters", () => {
    expect(base32(new Uint8Array(16))).toBe("a".repeat(26));
    expect(deriveAnonId(newSecret(), 0)).toMatch(/^[a-z2-7]{26}$/);
  });
});

describe("events", () => {
  const envelope = {
    schema: 1,
    registry: 1,
    event: "feature.activate",
    event_id: "6f1c0f0e-3d0a-4a5e-9a4e-2f6b7c8d9e01",
    anon_id: "k3m4q2v7x5b6n4r6t2y3wzq4sc",
    install_seq: 42,
    ts: 1792747832000,
    client: "0.2.0",
    platform: "macos",
    feature_id: "backlog.create",
    action: "create",
    dim: "quick"
  };

  it("accepts the spec's examples and rejects anything extra", () => {
    expect(() => parseEvent(envelope)).not.toThrow();
    expect(() => AnalyticsEvent.parse({ ...envelope, title: "secret" })).toThrow();
    expect(() => Batch.parse({ batch_id: envelope.event_id, sent_at: envelope.ts, events: [envelope], extra: 1 })).toThrow();
    expect(() => parseEvent({ ...envelope, anon_id: "not-an-id" })).toThrow();
    expect(() => parseEvent({ ...envelope, action: "delete" })).toThrow();
  });

  it("drops an unregistered dimension but keeps the event", () => {
    const parsed = parseEvent({ ...envelope, dim: "paste" });
    expect(parsed.event).toBe("feature.activate");
    expect(parsed.event === "feature.activate" ? parsed.dim : undefined).toBeNull();
  });

  it("keeps an unknown feature id and refuses an impossible session", () => {
    const unknown = { ...envelope, feature_id: "future.thing", action: "open" };
    expect(checkSemantics(AnalyticsEvent.parse(unknown)).ok).toBe(true);
    const bad = {
      ...envelope,
      event: "feature.session",
      action: null,
      dim: null,
      feature_id: "backlog.board",
      session_id: "1d2c3b4a-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
      started_at: 1792747832000,
      ended_at: 1792747833000,
      active_ms: 9000,
      idle_ms: 0,
      segments: 1,
      end_reason: "switch"
    };
    expect(() => parseEvent(bad)).toThrow(/wall clock/);
  });
});

describe("session timing", () => {
  it("counts five continuous minutes to within five seconds", () => {
    const { clock, rec, tracker } = setup();
    tracker.reportSurface("backlog.board");
    for (let i = 0; i < 60; i++) {
      clock.advance(5000);
      tracker.tick();
      tracker.sampleIdle();
    }
    tracker.quit();
    expect(rec.sessions).toHaveLength(1);
    expect(rec.sessions[0]!.activeMs).toBeGreaterThanOrEqual(295_000);
    expect(rec.sessions[0]!.activeMs).toBeLessThanOrEqual(300_000);
    expect(rec.sessions[0]!.featureId).toBe("backlog.board");
    expect(rec.sessions[0]!.endReason).toBe("quit");
    expect(rec.events.filter((e) => e.action === "open")).toHaveLength(1);
  });

  it("stops for a short blur without counting a new open", () => {
    const { clock, host, rec, tracker } = setup();
    tracker.reportSurface("backlog.board");
    clock.advance(30_000);
    tracker.tick();
    tracker.blur();
    host.focused = false;
    clock.advance(10_000);
    tracker.tick();
    host.focused = true;
    tracker.focus();
    clock.advance(30_000);
    tracker.tick();
    tracker.quit();
    expect(rec.events.filter((e) => e.action === "open")).toHaveLength(1);
    expect(rec.sessions).toHaveLength(1);
    expect(rec.sessions[0]!.activeMs).toBe(60_000);
  });

  it("ends the use after a forty-second blur and counts the return", () => {
    const { clock, host, rec, tracker } = setup();
    tracker.reportSurface("backlog.board");
    clock.advance(30_000);
    tracker.tick();
    tracker.blur();
    host.focused = false;
    for (let i = 0; i < 8; i++) {
      clock.advance(5000);
      tracker.tick();
    }
    expect(rec.sessions).toHaveLength(1);
    expect(rec.sessions[0]!.endReason).toBe("blur");
    expect(rec.sessions[0]!.endedAt - rec.sessions[0]!.startedAt).toBe(30_000);
    host.focused = true;
    tracker.focus();
    clock.advance(10_000);
    tracker.tick();
    tracker.quit();
    expect(rec.events.filter((e) => e.action === "open")).toHaveLength(2);
    expect(rec.sessions).toHaveLength(2);
  });

  it("pauses on a minute of idle and continues the same session", () => {
    const { clock, host, rec, tracker } = setup();
    tracker.reportSurface("backlog.board");
    clock.advance(30_000);
    tracker.tick();
    host.idle = 61_000;
    clock.advance(61_000);
    tracker.sampleIdle();
    host.idle = 0;
    clock.advance(5_000);
    tracker.sampleIdle();
    clock.advance(30_000);
    tracker.tick();
    tracker.quit();
    expect(rec.sessions).toHaveLength(1);
    expect(rec.events.filter((e) => e.action === "open")).toHaveLength(1);
    expect(rec.sessions[0]!.activeMs).toBe(60_000);
    expect(rec.sessions[0]!.idleMs).toBe(66_000);
  });

  it("ends the session after five minutes of idle and starts a new one on return", () => {
    const { clock, host, rec, tracker } = setup();
    tracker.reportSurface("backlog.board");
    clock.advance(60_000);
    tracker.tick();
    host.idle = 301_000;
    clock.advance(301_000);
    tracker.sampleIdle();
    expect(rec.sessions).toHaveLength(1);
    expect(rec.sessions[0]!.endReason).toBe("idle");
    expect(rec.sessions[0]!.activeMs).toBe(60_000);
    host.idle = 0;
    clock.advance(1_000);
    tracker.sampleIdle();
    clock.advance(10_000);
    tracker.tick();
    tracker.quit();
    expect(rec.sessions).toHaveLength(2);
    expect(rec.events.filter((e) => e.action === "open")).toHaveLength(2);
  });

  it("emits nothing while the switch is off", () => {
    const { clock, rec, tracker, setEnabled } = setup();
    setEnabled(false);
    tracker.reportSurface("backlog.board");
    clock.advance(300_000);
    tracker.tick();
    tracker.activate("settings", "open");
    tracker.quit();
    expect(rec.events).toHaveLength(0);
    expect(rec.sessions).toHaveLength(0);
  });

  it("restores a crashed session only up to its last heartbeat", () => {
    const { rec, tracker } = setup();
    tracker.recover({
      featureId: "backlog.board",
      sessionId: "1d2c3b4a-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
      startedAt: 1_792_747_832_000,
      activeMs: 90_000,
      segments: 2,
      at: 1_792_747_922_000
    });
    expect(rec.sessions).toHaveLength(1);
    expect(rec.sessions[0]!.endReason).toBe("crash");
    expect(rec.sessions[0]!.activeMs).toBe(90_000);
  });

  it("does not count a surface switch as a second open within thirty seconds", () => {
    const { clock, rec, tracker } = setup();
    tracker.reportSurface("backlog.board");
    clock.advance(10_000);
    tracker.reportSurface("backlog.table");
    clock.advance(10_000);
    tracker.reportSurface("backlog.board");
    clock.advance(10_000);
    tracker.tick();
    tracker.quit();
    expect(rec.sessions).toHaveLength(3);
    expect(rec.events.filter((e) => e.action === "open")).toHaveLength(2);
  });
});

describe("queue", () => {
  const event = (n: number, ts = 1_792_747_832_000) => ({
    schema: 1 as const,
    registry: 1,
    event: "feature.activate" as const,
    event_id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    anon_id: "k3m4q2v7x5b6n4r6t2y3wzq4sc",
    install_seq: n,
    ts,
    client: "0.2.0",
    platform: "macos" as const,
    feature_id: "backlog.board",
    action: "open",
    dim: null
  });

  it("persists across instances and drops what the server took", () => {
    const file = path.join(dir, "queue.jsonl");
    const first = new EventQueue(file);
    first.push(event(1));
    first.push(event(2));
    expect(fs.readFileSync(file, "utf8").trim().split("\n")).toHaveLength(2);
    const second = new EventQueue(file);
    expect(second.size).toBe(2);
    second.remove(new Set([event(1).event_id]));
    expect(new EventQueue(file).all().map((e) => e.install_seq)).toEqual([2]);
    second.clear();
    expect(new EventQueue(file).size).toBe(0);
  });

  it("drops events past the local retention window", () => {
    const file = path.join(dir, "queue-old.jsonl");
    const queue = new EventQueue(file);
    queue.push(event(1, 1_000));
    queue.push(event(2, Date.now()));
    queue.prune();
    expect(queue.all().map((e) => e.install_seq)).toEqual([2]);
  });
});
