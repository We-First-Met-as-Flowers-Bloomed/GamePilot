import { createHash } from "node:crypto";
import {
  mkdtemp,
  readdir,
  readFile,
  writeFile,
  rm,
  link,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, link: vi.fn(actual.link) };
});
import { StartupReconciliationStore } from "../apps/desktop/main/startup-reconciliation-store";
import type { StartupReconciliationFact } from "../packages/protocol/startup-reconciliation";

const directories: string[] = [];
async function directory() {
  const value = await mkdtemp(join(tmpdir(), "gp-startup-facts-"));
  directories.push(value);
  return value;
}
afterEach(async () => {
  vi.mocked(link).mockReset();
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  vi.mocked(link).mockImplementation(actual.link);
  for (const value of directories.splice(0)) {
    const inside = relative(resolve(tmpdir()), resolve(value));
    if (!inside || inside.startsWith("..") || isAbsolute(inside))
      throw Error("unsafe fixture cleanup");
    await rm(value, { recursive: true, force: true });
  }
});
const filename = (id: string) =>
  createHash("sha256").update(id).digest("hex") + ".json";
function fact(id = "fact-one"): StartupReconciliationFact {
  const resource = "mumu:d:\\mumu\\manager.exe#0";
  return {
    version: 1,
    id,
    candidate: {
      version: 1,
      originalRequestId: "old:lane-a",
      originalFingerprint: "a".repeat(64),
      originalRunId: "old-run",
      skillId: "login",
      evidenceHash: "b".repeat(64),
      gameDay: "2026-10-07",
      binding: {
        resource,
        laneId: "lane-a",
        instance: 0,
        profileId: "fixture-profile",
        clientType: "Official",
        identityHash: "c".repeat(64),
        profileHash: "d".repeat(64),
      },
    },
    executorExit: {
      verified: true,
      requestId: "old:lane-a",
      resource,
      observedAt: "2026-10-07T00:00:00.000Z",
      evidenceReference: "fixture-exit",
    },
    freshLogin: {
      requestId: "new:lane-a",
      requestFingerprint: "e".repeat(64),
      runId: "new-run",
      evidenceHash: "f".repeat(64),
      observedAt: "2026-10-07T00:00:01.000Z",
      evidenceReference: "fixture-login",
    },
    reconciledAt: "2026-10-07T00:00:02.000Z",
  };
}

it("persists independent facts and restores clones without modifying original ledgers", async () => {
  const root = await directory();
  const store = new StartupReconciliationStore(root);
  await store.load();
  expect(store.snapshot()).toEqual([]);
  const value = fact();
  expect(await store.append(value)).toEqual(value);
  expect(await readdir(root)).toEqual([filename(value.id)]);
  expect(
    JSON.parse(await readFile(join(root, filename(value.id)), "utf8")),
  ).toEqual(value);
  const view = store.snapshot();
  view[0].candidate.binding.laneId = "changed";
  expect(store.forOriginal(value.candidate.originalRequestId)).toEqual([value]);
  const reopened = new StartupReconciliationStore(root);
  await reopened.load();
  expect(reopened.snapshot()).toEqual([value]);
  expect(reopened.forOriginal("unrelated-request")).toEqual([]);
});

it("is idempotent for identical facts and refuses changes to an existing fact id", async () => {
  const root = await directory();
  const store = new StartupReconciliationStore(root);
  await store.load();
  const value = fact();
  await store.append(value);
  const before = await readFile(join(root, filename(value.id)), "utf8");
  await store.append(structuredClone(value));
  const conflict = structuredClone(value);
  conflict.freshLogin.evidenceReference = "another-proof";
  await expect(store.append(conflict)).rejects.toMatchObject({
    code: "STARTUP_RECONCILIATION_CONFLICT",
  });
  expect(await readFile(join(root, filename(value.id)), "utf8")).toBe(before);
  expect(store.snapshot()).toEqual([value]);
  expect(await readdir(root)).toHaveLength(1);
});

it("serializes concurrent publication and captures the submitted fact before callers mutate it", async () => {
  const root = await directory();
  const store = new StartupReconciliationStore(root);
  await store.load();
  const first = fact("first");
  const writing = store.append(first);
  first.candidate.binding.laneId = "changed-after-submit";
  await Promise.all([
    writing,
    store.append(fact("second")),
    store.append(fact("second")),
  ]);
  await store.flush();
  expect(
    store
      .snapshot()
      .map((entry) => entry.id)
      .sort(),
  ).toEqual(["first", "second"]);
  expect(
    store
      .snapshot()
      .every((entry) => entry.candidate.binding.laneId === "lane-a"),
  ).toBe(true);
  expect(await readdir(root)).toHaveLength(2);
});

it("rejects malformed associations before publishing any fact", async () => {
  const root = await directory();
  const store = new StartupReconciliationStore(root);
  await store.load();
  const value = fact();
  value.executorExit.requestId = "another-old-request";
  await expect(store.append(value)).rejects.toMatchObject({
    code: "STARTUP_RECONCILIATION_INVALID",
  });
  expect(store.snapshot()).toEqual([]);
  expect(await readdir(root)).toEqual([]);
});

it.each(["invalid-json", "invalid-name", "id-mismatch"])(
  "blocks consumption of a damaged corpus: %s",
  async (kind) => {
    const root = await directory();
    const value = fact();
    await writeFile(
      join(
        root,
        kind === "invalid-name" ? "wrong-name.json" : filename("other-id"),
      ),
      kind === "invalid-json" ? "{broken" : JSON.stringify(value),
    );
    const store = new StartupReconciliationStore(root);
    await expect(store.load()).rejects.toMatchObject({
      code: "STARTUP_RECONCILIATION_STORE_UNAVAILABLE",
    });
    expect(() => store.assertHealthy()).toThrow();
    expect(() => store.snapshot()).toThrow();
    await expect(store.append(fact("next"))).rejects.toMatchObject({
      code: "STARTUP_RECONCILIATION_STORE_UNAVAILABLE",
    });
  },
);

it("does not expose a staged crash fragment as a published reconciliation", async () => {
  const root = await directory();
  await writeFile(
    join(root, filename("fact-one") + ".tmp"),
    JSON.stringify(fact()),
  );
  const store = new StartupReconciliationStore(root);
  await store.load();
  expect(store.snapshot()).toEqual([]);
});

it("retains the old committed fact and blocks further consumption when atomic publication fails", async () => {
  const root = await directory();
  const store = new StartupReconciliationStore(root);
  await store.load();
  const value = fact();
  await store.append(value);
  vi.mocked(link).mockRejectedValueOnce(
    Object.assign(new Error("private filesystem failure"), { code: "EACCES" }),
  );
  await expect(store.append(fact("next"))).rejects.toMatchObject({
    code: "STARTUP_RECONCILIATION_STORE_UNAVAILABLE",
  });
  expect(() => store.snapshot()).toThrow();
  expect(
    JSON.parse(await readFile(join(root, filename(value.id)), "utf8")),
  ).toEqual(value);
  expect(await readdir(root)).toEqual([filename(value.id)]);
});

it("never overwrites another writer's committed fact at the same id", async () => {
  const root = await directory();
  const store = new StartupReconciliationStore(root);
  await store.load();
  const existing = fact();
  existing.freshLogin.evidenceReference = "existing-proof";
  await writeFile(join(root, filename(existing.id)), JSON.stringify(existing));
  await expect(store.append(fact())).rejects.toMatchObject({
    code: "STARTUP_RECONCILIATION_CONFLICT",
  });
  expect(
    JSON.parse(await readFile(join(root, filename(existing.id)), "utf8")),
  ).toEqual(existing);
});
