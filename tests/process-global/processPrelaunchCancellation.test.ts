import { createHash } from "node:crypto";
import { readFile, rm, stat, type FileHandle } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";

const sample = vi.hoisted(() => ({
  phase: "normal",
  controller: new AbortController(),
  reason: new Error("caller cancelled before PTY launch"),
  handles: [] as FileHandle[],
  statCalls: 0,
  spawn: vi.fn(() => {
    throw new Error("intercepted PTY launch; no process created");
  }),
}));

// Keep real executable IO, but synchronize cancellation with its completion.
// Module interception belongs in this isolated process-global project.
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (args[0] !== process.execPath) return handle;
      sample.handles.push(handle);
      const descriptorStat = handle.stat.bind(handle);
      const close = handle.close.bind(handle);
      if (sample.phase === "open") sample.controller.abort(sample.reason);
      handle.stat = (async (...options: Parameters<FileHandle["stat"]>) => {
        const metadata = await descriptorStat(...options);
        sample.statCalls += 1;
        if (sample.phase === "final-stat" && sample.statCalls === 2)
          sample.controller.abort(sample.reason);
        return metadata;
      }) as FileHandle["stat"];
      handle.close = async () => {
        await close();
        if (sample.phase === "close") sample.controller.abort(sample.reason);
      };
      return handle;
    },
  };
});

// No OS process ownership or native PTY capability is claimed by this test.
vi.mock(
  "../../src/process/ProcessOwnershipObservation.js",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("../../src/process/ProcessOwnershipObservation.js")
      >();
    return {
      ...original,
      prepareProcessOwnershipInspection: async () => {},
      systemProcessOwnershipHost: {
        ...original.systemProcessOwnershipHost,
        captureBaseline: async () => [],
      },
    };
  },
);

// Resolve the real entry point so linked node_modules use the same mock as the
// production dynamic import. Verify interception before entering the harness.
vi.doMock(fileURLToPath(import.meta.resolve("@lydell/node-pty")), () => ({
  spawn: sample.spawn,
}));

const { captureProcessScenario } =
  await import("../../src/process/capture/ProcessHarness.js");
const { observeSelectedExecutable } =
  await import("../../src/process/capture/ProcessCaptureLifecycle.js");
const { parseProcessScenario } =
  await import("../../src/domain/process/processScenario.js");

afterEach(async () => {
  for (const handle of sample.handles) if (handle.fd >= 0) await handle.close();
  sample.handles.length = 0;
  sample.statCalls = 0;
  sample.spawn.mockClear();
});

it.each(["normal", "open", "final-stat", "close", "pre-aborted"])(
  "checks cancellation before PTY launch after %s executable sampling",
  async (phase) => {
    expect((await import("@lydell/node-pty")).spawn).toBe(sample.spawn);
    sample.phase = phase;
    sample.controller = new AbortController();
    if (phase === "pre-aborted") sample.controller.abort(sample.reason);
    const removedRoots: string[] = [];
    const result = await captureProcessScenario(
      parseProcessScenario({
        executable: process.execPath,
        arguments: ["--eval", "process.exit(0)"],
        working_directory: process.cwd(),
      }),
      sample.controller.signal,
      "linux",
      {},
      undefined,
      {
        platform: "linux",
        cleanupProcessGroup: async () => ({ cleaned: true, signaled: false }),
        verifyTokenOwnedProcesses: async () => ({
          cleaned: true,
          signaled: false,
        }),
        removeTemporaryRoot: async (path) => {
          await rm(path, { recursive: true, force: true });
          removedRoots.push(path);
        },
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok)
      throw new Error("expected intercepted launch or cancellation");
    if (phase === "normal") {
      expect(sample.spawn).toHaveBeenCalledOnce();
      expect(result.error.executionFailure).toBe(
        "intercepted PTY launch; no process created",
      );
    } else {
      expect(sample.spawn.mock.calls.length).toBe(0);
      expect(result.error).toMatchObject({ reason: "cancelled" });
    }
    expect(sample.handles).toHaveLength(phase === "pre-aborted" ? 0 : 1);
    expect(sample.statCalls).toBe(
      phase === "pre-aborted" ? 0 : phase === "open" ? 1 : 2,
    );
    expect(result.error.cleanupIncomplete).toBe(false);
    for (const handle of sample.handles) expect(handle.fd).toBe(-1);
    expect(new Set(removedRoots).size).toBe(phase === "pre-aborted" ? 0 : 1);
    for (const root of removedRoots)
      await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it.each(["final-stat", "close"])(
  "keeps the completed executable digest when cancellation arrives during %s",
  async (phase) => {
    const digest = createHash("sha256")
      .update(await readFile(process.execPath))
      .digest("hex");
    sample.phase = phase;
    sample.controller = new AbortController();
    const selected = await observeSelectedExecutable(
      process.execPath,
      sample.controller.signal,
    );
    expect(sample.controller.signal.aborted).toBe(true);
    expect(selected).toMatchObject({ sha256: digest, reason: null });
    expect(sample.handles[0]?.fd).toBe(-1);
  },
);
