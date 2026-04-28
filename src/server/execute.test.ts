import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type * as k8s from "@kubernetes/client-node";
import type { Writable } from "node:stream";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

// All K8s API mock functions — declared before vi.mock() so the factory can
// reference them.  The mock's logApi.log default is a never-resolving promise,
// simulating the FAR-10 hang where K8s API drops the connection indefinitely.
const mockLogFn = vi.fn();
const mockGetSelfPodInfo = vi.fn();
const mockBatchListJobs = vi.fn();
const mockBatchCreateJob = vi.fn();
const mockBatchReadJob = vi.fn();
const mockBatchDeleteJob = vi.fn();
const mockBatchPatchJob = vi.fn();
const mockCoreListPods = vi.fn();
const mockCoreReadPodLog = vi.fn();
const mockCoreCreateSecret = vi.fn();
const mockCorePatchSecret = vi.fn();
const mockCoreDeleteSecret = vi.fn();
// vi.hoisted ensures a single vi.fn() instance shared between the mock factory
// (which runs at hoist time) and the test body (which calls mockResolvedValue).
// A plain const would be re-assigned at its original position, leaving the
// factory with a stale reference to a different vi.fn() instance.
const mockReadSkillEntries = vi.hoisted(() => vi.fn());

// Module-level state for fs mock - kept for future use if mock is needed
const mockFsContent = new Map<string, string>();

vi.mock("./k8s-client.js", () => ({
  getLogApi: () => ({ log: mockLogFn }),
  getBatchApi: () => ({
    listNamespacedJob: mockBatchListJobs,
    createNamespacedJob: mockBatchCreateJob,
    readNamespacedJob: mockBatchReadJob,
    deleteNamespacedJob: mockBatchDeleteJob,
    patchNamespacedJob: mockBatchPatchJob,
  }),
  getCoreApi: () => ({
    listNamespacedPod: mockCoreListPods,
    readNamespacedPodLog: mockCoreReadPodLog,
    createNamespacedSecret: mockCoreCreateSecret,
    patchNamespacedSecret: mockCorePatchSecret,
    deleteNamespacedSecret: mockCoreDeleteSecret,
  }),
  getAuthzApi: () => ({}),
  getSelfPodInfo: mockGetSelfPodInfo,
  resetCache: vi.fn(),
}));

const mockPrepareBundle = vi.fn();
vi.mock("./prompt-cache.js", () => ({
  prepareClaudePromptBundle: mockPrepareBundle,
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const original = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  // Enumerate all original exports so transitive deps (job-manifest.ts, parse.ts,
  // prompt-cache.ts, etc.) keep working.  Only readPaperclipRuntimeSkillEntries
  // is replaced so tests run without real fs.stat I/O under fake timers.
  return Object.assign(Object.create(null), original, {
    readPaperclipRuntimeSkillEntries: mockReadSkillEntries,
  });
});

const { isK8s404, buildPartialRunError, classifyOrphan, describePodTerminatedError, describeTruncationCause, streamPodLogsOnce, shouldAbortForCancellation, execute } = await import("./execute.js");

function makeJob(opts: {
  runId?: string;
  agentId?: string;
  taskId?: string;
  sessionId?: string;
  adapterType?: string;
  terminal?: boolean;
}): k8s.V1Job {
  const labels: Record<string, string> = {
    "paperclip.io/adapter-type": opts.adapterType ?? "claude_k8s",
  };
  if (opts.agentId) labels["paperclip.io/agent-id"] = opts.agentId;
  if (opts.runId) labels["paperclip.io/run-id"] = opts.runId;
  if (opts.taskId) labels["paperclip.io/task-id"] = opts.taskId;
  if (opts.sessionId) labels["paperclip.io/session-id"] = opts.sessionId;
  return {
    metadata: { name: "ac-job", namespace: "paperclip", labels },
    status: opts.terminal
      ? { conditions: [{ type: "Complete", status: "True" }] }
      : { conditions: [] },
  } as k8s.V1Job;
}

describe("isK8s404", () => {
  it("returns false for non-Error values", () => {
    expect(isK8s404(null)).toBe(false);
    expect(isK8s404(undefined)).toBe(false);
    expect(isK8s404("string error")).toBe(false);
    expect(isK8s404(404)).toBe(false);
  });

  it("returns false for unrelated errors", () => {
    expect(isK8s404(new Error("something went wrong"))).toBe(false);
    expect(isK8s404(new Error("HTTP-Code: 500 Message: Internal Server Error"))).toBe(false);
  });

  it("detects 404 from v1.0+ message format", () => {
    const err = new Error("HTTP-Code: 404 Message: Unknown API Status Code! Body: ...");
    expect(isK8s404(err)).toBe(true);
  });

  it("detects 404 from v0.x response.statusCode", () => {
    const err = Object.assign(new Error("Not Found"), {
      response: { statusCode: 404 },
    });
    expect(isK8s404(err)).toBe(true);
  });

  it("detects 404 from v1.0+ response.status", () => {
    const err = Object.assign(new Error("Not Found"), {
      response: { status: 404 },
    });
    expect(isK8s404(err)).toBe(true);
  });

  it("detects 404 from direct statusCode property", () => {
    const err = Object.assign(new Error("Not Found"), { statusCode: 404 });
    expect(isK8s404(err)).toBe(true);
  });

  it("does not match non-404 status codes on response", () => {
    const err = Object.assign(new Error("Forbidden"), {
      response: { statusCode: 403 },
    });
    expect(isK8s404(err)).toBe(false);
  });
});

describe("buildPartialRunError", () => {
  const initLine = JSON.stringify({
    type: "system",
    subtype: "init",
    model: "claude-sonnet-4-6",
    session_id: "sess_abc",
  });

  it("returns parse-failure message when exitCode is 0", () => {
    expect(buildPartialRunError(0, "", "")).toBe("Failed to parse Claude JSON output");
    expect(buildPartialRunError(0, "claude-sonnet-4-6", initLine)).toBe(
      "Failed to parse Claude JSON output",
    );
  });

  it("returns generic exit message when stdout is empty", () => {
    expect(buildPartialRunError(1, "", "")).toBe("Claude exited with code 1");
    expect(buildPartialRunError(null, "", "")).toBe("Claude exited with code -1");
  });

  it("returns init-only message when stdout is init-only with non-zero exit code (FAR-101)", () => {
    const msg = buildPartialRunError(1, "claude-sonnet-4-6", initLine);
    expect(msg).toBe(
      "Claude exited immediately after init (model: claude-sonnet-4-6) (exit code 1) — the model may be unsupported or the session may have been rejected before producing output",
    );
  });

  it("includes model from parsedStream when stdout is init-only", () => {
    const msg = buildPartialRunError(null, "MiniMax-M2.7", initLine);
    expect(msg).toContain("MiniMax-M2.7");
    expect(msg).not.toContain("type");
    expect(msg).not.toContain("system");
  });

  it("uses first non-system line as content when present", () => {
    const stdout = [initLine, "Error: no API key configured"].join("\n");
    const msg = buildPartialRunError(1, "claude-sonnet-4-6", stdout);
    expect(msg).toBe("Claude exited with code 1: Error: no API key configured");
  });

  it("returns init-only message when stdout has init + result event but no plain content (structured artefact, not surfaced verbatim)", () => {
    // In production, buildPartialRunError is only called when parseClaudeStreamJson
    // returns null (no result event).  If somehow a result event appears here, the
    // raw JSON blob must not be shown — the init-only message is cleaner and avoids
    // leaking protocol internals to the UI.
    const resultLike = JSON.stringify({ type: "result", subtype: "error", result: "rate limit" });
    const stdout = [initLine, resultLike].join("\n");
    const msg = buildPartialRunError(2, "claude-sonnet-4-6", stdout);
    expect(msg).toContain("Claude exited immediately after init");
    expect(msg).toContain("claude-sonnet-4-6");
    expect(msg).not.toMatch(/\{.*type.*result/);
  });

  it("skips rate_limit_event and surfaces model hint (FAR-32 Anthropic/Nancy repro)", () => {
    // Reproduces the second variant from FAR-32: init event + rate_limit_event +
    // assistant event (thinking only, no result).  The rate_limit_event JSON blob
    // must not appear verbatim in the error message.
    const rateLimitEvent = JSON.stringify({
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed", resetsAt: 1777056000, rateLimitType: "five_hour" },
      uuid: "3ab8f9eb-b9d6-4bf6-9c39-4608427717fc",
      session_id: "ad5f3e11-3c0c-4144-b53d-d4b959e57cee",
    });
    const stdout = [initLine, rateLimitEvent].join("\n");
    const msg = buildPartialRunError(null, "claude-opus-4-7", stdout);
    expect(msg).toContain("claude-opus-4-7");
    expect(msg).toContain("did not produce a result");
    expect(msg).not.toContain("rate_limit_event");
    expect(msg).not.toContain("rateLimitType");
  });

  it("skips assistant events and surfaces model hint (FAR-32: MiniMax-M2.7 output_tokens=0)", () => {
    // Reproduces the exact failure: init event + assistant event with only a
    // thinking block and output_tokens=0, no result event.  The assistant JSON
    // blob must not be surfaced verbatim as the error message.
    const assistantEvent = JSON.stringify({
      type: "assistant",
      message: {
        id: "063ad6038e4c889faa7c95168e007d73",
        type: "message",
        role: "assistant",
        content: [{ type: "thinking", thinking: "Let me start…", signature: "abc123" }],
        model: "MiniMax-M2.7",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 11013, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    });
    const stdout = [initLine, assistantEvent].join("\n");
    const msg = buildPartialRunError(null, "MiniMax-M2.7", stdout);
    expect(msg).toContain("MiniMax-M2.7");
    expect(msg).toContain("did not produce a result");
    expect(msg).not.toContain("063ad6038e4c889faa7c95168e007d73");
    expect(msg).not.toContain("output_tokens");
    expect(msg).not.toContain("thinking");
  });

  it("skips user events alongside system events", () => {
    const userEvent = JSON.stringify({ type: "user", message: { role: "user", content: [] } });
    const stdout = [initLine, userEvent, "Error: API quota exceeded"].join("\n");
    const msg = buildPartialRunError(1, "claude-sonnet-4-6", stdout);
    expect(msg).toBe("Claude exited with code 1: Error: API quota exceeded");
  });

  it("null exitCode renders as -1 in message", () => {
    const msg = buildPartialRunError(null, "", "Some plain error text");
    expect(msg).toBe("Claude exited with code -1: Some plain error text");
  });

  it("skips multiple consecutive system events", () => {
    const anotherSystem = JSON.stringify({ type: "system", subtype: "other" });
    const stdout = [initLine, anotherSystem, "real error line"].join("\n");
    const msg = buildPartialRunError(1, "model-x", stdout);
    expect(msg).toBe("Claude exited with code 1: real error line");
  });

  it("appends pod terminated reason/message when state is provided (FAR-100)", () => {
    const msg = buildPartialRunError(1, "claude-sonnet-4-6", initLine, {
      exitCode: 1,
      reason: "Error",
      message: "model not supported",
      signal: null,
    });
    expect(msg).toContain("Claude exited immediately after init");
    expect(msg).toContain("claude-sonnet-4-6");
    expect(msg).toContain("[pod: reason=Error, message=model not supported]");
  });

  it("flags exit 137 as OOMKilled in pod cause", () => {
    const msg = buildPartialRunError(137, "claude-sonnet-4-6", initLine, {
      exitCode: 137,
      reason: "OOMKilled",
      message: null,
      signal: null,
    });
    expect(msg).toContain("[pod: reason=OOMKilled, SIGKILL (commonly OOMKilled)]");
  });

  it("appends pod cause to content-line message", () => {
    const stdout = [initLine, "Error: bad request"].join("\n");
    const msg = buildPartialRunError(1, "claude-sonnet-4-6", stdout, {
      exitCode: 1,
      reason: "Error",
      message: null,
      signal: null,
    });
    expect(msg).toBe("Claude exited with code 1: Error: bad request [pod: reason=Error]");
  });

  it("does not append anything when podState is null (back-compat)", () => {
    const msg = buildPartialRunError(1, "claude-sonnet-4-6", initLine, null);
    expect(msg).not.toContain("[pod:");
  });
});

describe("classifyOrphan", () => {
  const taskId = "task-xyz";
  const sessionId = "sess-123";

  // --- Happy path: reattach ---
  it("returns reattach when taskId matches and both sessionIds match", () => {
    const job = makeJob({ taskId, sessionId });
    expect(classifyOrphan(job, { taskId, sessionId })).toBe("reattach");
  });

  it("returns reattach when taskId matches and expected sessionId is null (missing on current side)", () => {
    const job = makeJob({ taskId, sessionId });
    expect(classifyOrphan(job, { taskId, sessionId: null })).toBe("reattach");
  });

  it("returns reattach when taskId matches and job has no session-id label (missing on job side)", () => {
    const job = makeJob({ taskId });
    expect(classifyOrphan(job, { taskId, sessionId })).toBe("reattach");
  });

  it("returns reattach when taskId matches and neither side has a sessionId", () => {
    const job = makeJob({ taskId });
    expect(classifyOrphan(job, { taskId, sessionId: null })).toBe("reattach");
  });

  // --- Block: task unknown ---
  it("returns block_task_unknown when expected taskId is null", () => {
    const job = makeJob({ taskId, sessionId });
    expect(classifyOrphan(job, { taskId: null, sessionId })).toBe("block_task_unknown");
  });

  it("returns block_task_unknown when job has no task-id label", () => {
    const job = makeJob({ sessionId });
    expect(classifyOrphan(job, { taskId, sessionId })).toBe("block_task_unknown");
  });

  // --- Block: task mismatch ---
  it("returns block_task_mismatch when both sides have taskId but they differ", () => {
    const job = makeJob({ taskId: "task-other", sessionId });
    expect(classifyOrphan(job, { taskId, sessionId })).toBe("block_task_mismatch");
  });

  // --- Block: session mismatch ---
  it("returns block_session_mismatch when taskId matches but sessionIds differ", () => {
    const job = makeJob({ taskId, sessionId: "sess-other" });
    expect(classifyOrphan(job, { taskId, sessionId })).toBe("block_session_mismatch");
  });

  // --- Terminal orphan (caller filters these before classifyOrphan) ---
  it("returns reattach for terminal job (caller is responsible for filtering terminals)", () => {
    const job = makeJob({ taskId, sessionId, terminal: true });
    // classifyOrphan does not check terminal status — that is the caller's job
    expect(classifyOrphan(job, { taskId, sessionId })).toBe("reattach");
  });
});

// Regression: FAR-10 — waitForPod must throw on phase=Failed, not return the pod name.
// These tests cover describePodTerminatedError, the helper that waitForPod uses to build
// the error message before throwing.  Verifies that phase=Failed with no claude logs
// produces a structured, actionable error instead of silently entering the log-stream path.
describe("describePodTerminatedError", () => {
  it("includes exit code and reason when claude container status is available", () => {
    const cs = [
      {
        name: "claude",
        state: { terminated: { exitCode: 137, reason: "OOMKilled" } },
      },
    ] as k8s.V1ContainerStatus[];
    const msg = describePodTerminatedError("mypod", "Failed", cs);
    expect(msg).toContain("137");
    expect(msg).toContain("OOMKilled");
    expect(msg).toContain("phase=Failed");
  });

  it("falls back to message field when reason is absent", () => {
    const cs = [
      {
        name: "claude",
        state: { terminated: { exitCode: 1, message: "signal: killed" } },
      },
    ] as k8s.V1ContainerStatus[];
    const msg = describePodTerminatedError("mypod", "Failed", cs);
    expect(msg).toContain("signal: killed");
    expect(msg).toContain("1");
  });

  it("returns generic message when no claude container status is present", () => {
    const msg = describePodTerminatedError("mypod", "Failed", []);
    expect(msg).toBe("Pod mypod reached phase=Failed");
  });

  it("ignores non-claude containers", () => {
    const cs = [
      {
        name: "sidecar",
        state: { terminated: { exitCode: 0, reason: "Completed" } },
      },
    ] as k8s.V1ContainerStatus[];
    const msg = describePodTerminatedError("mypod", "Failed", cs);
    expect(msg).toBe("Pod mypod reached phase=Failed");
  });

  it("handles null exitCode gracefully", () => {
    const cs = [
      {
        name: "claude",
        state: { terminated: { exitCode: null, reason: "Error" } },
      },
    ] as unknown as k8s.V1ContainerStatus[];
    const msg = describePodTerminatedError("mypod", "Failed", cs);
    expect(msg).toContain("unknown");
    expect(msg).toContain("Error");
  });
});

describe("describeTruncationCause", () => {
  it("annotates exit code 137 as SIGKILL/OOM", () => {
    const msg = describeTruncationCause({ exitCode: 137, reason: "OOMKilled", message: "Memory cgroup out of memory", signal: null });
    expect(msg).toContain("exit code 137");
    expect(msg).toContain("SIGKILL");
    expect(msg).toContain("OOMKilled");
    expect(msg).toContain("Memory cgroup out of memory");
  });

  it("annotates exit code 143 as SIGTERM", () => {
    const msg = describeTruncationCause({ exitCode: 143, reason: null, message: null, signal: null });
    expect(msg).toContain("exit code 143");
    expect(msg).toContain("SIGTERM");
  });

  it("falls back to 'pod state unavailable' when state is null", () => {
    const msg = describeTruncationCause(null);
    expect(msg).toContain("pod state unavailable");
  });

  it("emits 'no exit code' when exitCode is null but state exists", () => {
    const msg = describeTruncationCause({ exitCode: null, reason: "Error", message: null, signal: null });
    expect(msg).toContain("no exit code");
    expect(msg).toContain("reason=Error");
  });
});

describe("execute: all-invalid agent.id (N4)", () => {
  it("returns hard error without creating a Job when agent.id sanitizes to null", async () => {
    const logs: string[] = [];
    const result = await execute({
      runId: "run-001",
      agent: { id: "@@@", companyId: "co1", name: "Bad Agent", adapterType: "claude_k8s", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {},
      context: {},
      onLog: async (_stream, msg) => { logs.push(msg); },
    });
    expect(result.errorCode).toBe("k8s_agent_id_invalid");
    expect(result.errorMessage).toContain("@@@");
    // getSelfPodInfo must NOT have been called (early return before K8s calls)
    const { getSelfPodInfo } = await import("./k8s-client.js");
    expect(getSelfPodInfo).not.toHaveBeenCalled();
  });
});


// ─── Helpers shared across execute() integration tests ───────────────────────

function makeCtx(overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return {
    runId: "run-test-001",
    agent: {
      id: "agent-abc",
      companyId: "co1",
      name: "Test Agent",
      adapterType: "claude_k8s",
      adapterConfig: {},
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {},
    context: {},
    onLog: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as AdapterExecutionContext;
}

function makeSelfPodResult() {
  return {
    namespace: "paperclip",
    image: "paperclipai/paperclip:latest",
    imagePullSecrets: [],
    dnsConfig: undefined,
    pvcClaimName: "paperclip-data",
    secretVolumes: [],
    inheritedEnv: {},
    inheritedEnvValueFrom: [],
    inheritedEnvFrom: [],
  };
}

function makeBundle() {
  return {
    bundleKey: "test-bundle",
    rootDir: "/tmp/test-bundle",
    addDir: "/tmp/test-bundle",
    instructionsFilePath: null,
  };
}

// Valid minimal Claude stream-json output used in happy-path tests.
const CLAUDE_HAPPY_OUTPUT = [
  JSON.stringify({ type: "system", subtype: "init", model: "claude-sonnet-4-6", session_id: "sess_test123" }),
  JSON.stringify({
    type: "result",
    subtype: "success",
    result: "Done.",
    session_id: "sess_test123",
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10 },
    total_cost_usd: 0.001,
  }),
].join("\n") + "\n";

// ─── execute: concurrency guard paths ────────────────────────────────────────

describe("execute: concurrency guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadSkillEntries.mockResolvedValue([]);
    mockGetSelfPodInfo.mockResolvedValue(makeSelfPodResult());
  });

  it("returns k8s_concurrency_guard_unreachable when listNamespacedJob throws", async () => {
    mockBatchListJobs.mockRejectedValue(new Error("K8s API unavailable"));
    const result = await execute(makeCtx());
    expect(result.errorCode).toBe("k8s_concurrency_guard_unreachable");
    expect(result.errorMessage).toContain("K8s API unavailable");
  });

  it("returns k8s_concurrent_run_blocked when reattach disabled and orphan is running", async () => {
    const orphan = makeJob({ runId: "prior-run", agentId: "agent-abc", terminal: false });
    mockBatchListJobs.mockResolvedValue({ items: [orphan] });
    const result = await execute(makeCtx({ config: { reattachOrphanedJobs: false } } as Partial<AdapterExecutionContext>));
    expect(result.errorCode).toBe("k8s_concurrent_run_blocked");
    expect(result.errorMessage).toContain("reattach disabled");
  });

  it("returns k8s_orphan_task_unknown when orphan has no task label", async () => {
    // No taskId on the orphan job and no taskId in context → block_task_unknown
    const orphan = makeJob({ runId: "prior-run", agentId: "agent-abc" }); // no taskId label
    mockBatchListJobs.mockResolvedValue({ items: [orphan] });
    // context.taskId absent → currentTaskLabel = null → block_task_unknown
    const result = await execute(makeCtx());
    expect(result.errorCode).toBe("k8s_orphan_task_unknown");
  });

  it("returns k8s_concurrent_run_blocked when orphan task-id mismatches current task", async () => {
    const orphan = makeJob({ runId: "prior-run", agentId: "agent-abc", taskId: "task-other" });
    mockBatchListJobs.mockResolvedValue({ items: [orphan] });
    const result = await execute(
      makeCtx({ context: { taskId: "task-current" } } as Partial<AdapterExecutionContext>),
    );
    expect(result.errorCode).toBe("k8s_concurrent_run_blocked");
    expect(result.errorMessage).toContain("different task");
  });

  it("returns k8s_orphan_session_mismatch when task matches but session differs", async () => {
    const orphan = makeJob({
      runId: "prior-run",
      agentId: "agent-abc",
      taskId: "task-match",
      sessionId: "sess-other",
    });
    mockBatchListJobs.mockResolvedValue({ items: [orphan] });
    const result = await execute(
      makeCtx({
        context: { taskId: "task-match" },
        runtime: { sessionId: "sess-current", sessionParams: null, sessionDisplayId: null, taskKey: null },
      } as Partial<AdapterExecutionContext>),
    );
    expect(result.errorCode).toBe("k8s_orphan_session_mismatch");
    expect(result.errorMessage).toContain("mismatched session");
  });

  it("returns k8s_concurrent_run_blocked when same-run job is still running", async () => {
    // runId matches → samRun.length > 0 → blocked
    const sameRunJob = makeJob({ runId: "run-test-001", agentId: "agent-abc", terminal: false });
    mockBatchListJobs.mockResolvedValue({ items: [sameRunJob] });
    const result = await execute(makeCtx());
    expect(result.errorCode).toBe("k8s_concurrent_run_blocked");
    expect(result.errorMessage).toContain("still running for this agent");
  });

  it("ignores terminating jobs (deletionTimestamp set) and proceeds past the concurrency guard", async () => {
    // A job being force-deleted has deletionTimestamp set but no Complete/Failed condition.
    // The guard must treat it as terminal so subsequent runs are not blocked.
    const terminating: k8s.V1Job = {
      metadata: {
        name: "terminating-job",
        namespace: "paperclip",
        labels: { "paperclip.io/agent-id": "agent-abc", "paperclip.io/adapter-type": "claude_k8s" },
        deletionTimestamp: new Date(),
      },
      status: { conditions: [] },
    };
    mockBatchListJobs.mockResolvedValue({ items: [terminating] });
    // Guard passes → next failure is job creation (no further mocks set up)
    mockBatchCreateJob.mockRejectedValue(new Error("quota exceeded"));
    mockPrepareBundle.mockResolvedValue(makeBundle());
    const result = await execute(makeCtx());
    // Must NOT be a concurrency error — the guard let us through
    expect(result.errorCode).not.toBe("k8s_concurrent_run_blocked");
    expect(result.errorCode).toBe("k8s_job_create_failed");
  });

  it("reattaches to a matching orphan and returns k8s_pod_reattach_failed when pod is missing", async () => {
    // Orphan with matching taskId and sessionId → reattach classification → reattachTarget is set
    const orphan = makeJob({
      runId: "prior-run",
      agentId: "agent-abc",
      taskId: "task-match",
      sessionId: "sess-match",
    });
    mockBatchListJobs.mockResolvedValue({ items: [orphan] });
    mockBatchPatchJob.mockResolvedValue({});
    mockPrepareBundle.mockResolvedValue(makeBundle());
    // Pod lookup finds nothing → reattach pod-not-found error
    mockCoreListPods.mockResolvedValue({ items: [] });

    const result = await execute(
      makeCtx({
        context: { taskId: "task-match" },
        runtime: { sessionId: "sess-match", sessionParams: null, sessionDisplayId: null, taskKey: null },
      } as Partial<AdapterExecutionContext>),
    );

    expect(result.errorCode).toBe("k8s_pod_reattach_failed");
    expect(result.errorMessage).toContain("no pod");
  });
});

// ─── execute: job creation paths ─────────────────────────────────────────────

describe("execute: job creation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockReadSkillEntries.mockResolvedValue([]);
    mockGetSelfPodInfo.mockResolvedValue(makeSelfPodResult());
    mockBatchListJobs.mockResolvedValue({ items: [] }); // no concurrent jobs
    mockPrepareBundle.mockResolvedValue(makeBundle());
    mockBatchCreateJob.mockResolvedValue({ metadata: { uid: "job-uid-1" } });
    mockBatchDeleteJob.mockResolvedValue({});
  });

  it("returns k8s_job_create_failed when createNamespacedJob throws", async () => {
    mockBatchCreateJob.mockRejectedValue(new Error("quota exceeded"));
    const result = await execute(makeCtx());
    expect(result.errorCode).toBe("k8s_job_create_failed");
    expect(result.errorMessage).toContain("quota exceeded");
  });

  it("returns k8s_pod_schedule_failed when pod scheduling times out", async () => {
    mockBatchCreateJob.mockResolvedValue({ metadata: { uid: "uid-1" } });
    mockBatchDeleteJob.mockResolvedValue({});
    // Pod never appears → waitForPod eventually times out.
    // Provide a config with very short timeout to avoid a real 2-minute wait.
    // Instead, make listNamespacedPod return an unschedulable condition immediately.
    mockCoreListPods.mockResolvedValue({
      items: [
        {
          metadata: { name: "pod-xyz" },
          status: {
            phase: "Pending",
            conditions: [
              { type: "PodScheduled", status: "False", reason: "Unschedulable", message: "no nodes available" },
            ],
            containerStatuses: [],
            initContainerStatuses: [],
          },
        },
      ],
    });

    const result = await execute(makeCtx());

    expect(result.errorCode).toBe("k8s_pod_schedule_failed");
    expect(result.errorMessage).toContain("unschedulable");
  });
});

// ─── execute: waitForPod edge cases ──────────────────────────────────────────

describe("execute: waitForPod edge cases", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockReadSkillEntries.mockResolvedValue([]);
    mockGetSelfPodInfo.mockResolvedValue(makeSelfPodResult());
    mockBatchListJobs.mockResolvedValue({ items: [] });
    mockPrepareBundle.mockResolvedValue(makeBundle());
    mockBatchCreateJob.mockResolvedValue({ metadata: { uid: "uid-1" } });
    mockBatchDeleteJob.mockResolvedValue({});
  });

  it("throws k8s_pod_schedule_failed when pod reaches phase=Failed immediately", async () => {
    mockCoreListPods.mockResolvedValue({
      items: [{
        metadata: { name: "pod-fail" },
        status: {
          phase: "Failed",
          containerStatuses: [{ name: "claude", state: { terminated: { exitCode: 137, reason: "OOMKilled" } } }],
          initContainerStatuses: [],
        },
      }],
    });

    const result = await execute(makeCtx());

    expect(result.errorCode).toBe("k8s_pod_schedule_failed");
    expect(result.errorMessage).toContain("OOMKilled");
  });

  it("throws k8s_pod_schedule_failed when init container exits non-zero", async () => {
    mockCoreListPods.mockResolvedValue({
      items: [{
        metadata: { name: "pod-x" },
        status: {
          phase: "Pending",
          initContainerStatuses: [{
            name: "write-prompt",
            state: { terminated: { exitCode: 1, reason: "Error" } },
          }],
          containerStatuses: [],
        },
      }],
    });

    const result = await execute(makeCtx());

    expect(result.errorCode).toBe("k8s_pod_schedule_failed");
    expect(result.errorMessage).toContain("write-prompt");
  });

  it("throws k8s_pod_schedule_failed when init container has ImagePullBackOff", async () => {
    mockCoreListPods.mockResolvedValue({
      items: [{
        metadata: { name: "pod-x" },
        status: {
          phase: "Pending",
          initContainerStatuses: [{
            name: "write-prompt",
            state: { waiting: { reason: "ImagePullBackOff", message: "pull failed" } },
          }],
          containerStatuses: [],
        },
      }],
    });

    const result = await execute(makeCtx());

    expect(result.errorCode).toBe("k8s_pod_schedule_failed");
    expect(result.errorMessage).toContain("image pull");
  });

  it("throws k8s_pod_schedule_failed when main container has CrashLoopBackOff", async () => {
    mockCoreListPods.mockResolvedValue({
      items: [{
        metadata: { name: "pod-x" },
        status: {
          phase: "Pending",
          initContainerStatuses: [],
          containerStatuses: [{
            name: "claude",
            state: { waiting: { reason: "CrashLoopBackOff" } },
          }],
        },
      }],
    });

    const result = await execute(makeCtx());

    expect(result.errorCode).toBe("k8s_pod_schedule_failed");
    expect(result.errorMessage).toContain("crash loop");
  });
});

// ─── execute: grace-period fallback (FAR-23) ─────────────────────────────────


// ─── execute: concurrency guard — multiple orphan sorting ────────────────────

describe("execute: concurrency guard — multiple orphans", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSelfPodInfo.mockResolvedValue(makeSelfPodResult());
  });

  it("sorts multiple orphans newest-first and processes them in that order", async () => {
    // orphanNew has a newer timestamp and a mismatching task → block_task_mismatch
    // orphanOld has an older timestamp and a matching task → would reattach
    // The sort (lines 603-605) must put orphanNew first so it is the one classified.
    const orphanOld = makeJob({ runId: "prior-1", agentId: "agent-abc", taskId: "task-match" });
    orphanOld.metadata!.creationTimestamp = new Date("2024-01-01T00:00:00Z") as unknown as Date;
    const orphanNew = makeJob({ runId: "prior-2", agentId: "agent-abc", taskId: "task-other" });
    orphanNew.metadata!.creationTimestamp = new Date("2024-01-02T00:00:00Z") as unknown as Date;

    mockBatchListJobs.mockResolvedValue({ items: [orphanOld, orphanNew] });
    const result = await execute(
      makeCtx({ context: { taskId: "task-match" } } as Partial<AdapterExecutionContext>),
    );

    // Newest orphan (task-other) is classified first → block_task_mismatch
    expect(result.errorCode).toBe("k8s_concurrent_run_blocked");
    expect(result.errorMessage).toContain("different task");
  });
});

// ─── shouldAbortForCancellation ──────────────────────────────────────────────

describe("shouldAbortForCancellation", () => {
  it("returns false for undefined", () => {
    expect(shouldAbortForCancellation(undefined)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(shouldAbortForCancellation("")).toBe(false);
  });

  it("returns false when status is 'running'", () => {
    expect(shouldAbortForCancellation("running")).toBe(false);
  });

  it("returns true when status is 'cancelled'", () => {
    expect(shouldAbortForCancellation("cancelled")).toBe(true);
  });

  it("returns true when status is 'cancelling'", () => {
    expect(shouldAbortForCancellation("cancelling")).toBe(true);
  });

  // FAR-107: terminal-but-not-cancelled statuses MUST NOT trigger Job deletion.
  // The previous "anything but running" guard caused k8s_job_deleted_externally
  // false positives for in-flight runs whenever the API briefly reported a
  // transient/stale status.
  it("returns false for non-cancellation terminal statuses (FAR-107)", () => {
    expect(shouldAbortForCancellation("succeeded")).toBe(false);
    expect(shouldAbortForCancellation("failed")).toBe(false);
    expect(shouldAbortForCancellation("completed")).toBe(false);
  });

  it("returns false for unknown statuses (FAR-107)", () => {
    expect(shouldAbortForCancellation("unknown")).toBe(false);
    expect(shouldAbortForCancellation("queued")).toBe(false);
    expect(shouldAbortForCancellation("pending")).toBe(false);
  });
});


// ─── execute: per-agent creation mutex (FAR-29 TOCTOU fix) ───────────────────
//
// Verifies that two concurrent execute() calls for the same agent cannot both
// enter the listNamespacedJob → createNamespacedJob sequence simultaneously.
// Without the per-agent mutex, both would pass the concurrency guard before
// either job appears in the other's list query.

describe("execute: per-agent creation mutex prevents TOCTOU race", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockReadSkillEntries.mockResolvedValue([]);
    mockGetSelfPodInfo.mockResolvedValue(makeSelfPodResult());
    mockPrepareBundle.mockResolvedValue(makeBundle());
    // Make job creation fail so the guard+create phase exits quickly and
    // releases the mutex without needing to mock the full streaming path.
    mockBatchCreateJob.mockRejectedValue(new Error("mock: create not configured"));
    mockBatchDeleteJob.mockResolvedValue({});
    mockCoreDeleteSecret.mockResolvedValue({});
  });

  it("serializes guard phases for the same agent: call-2 waits until call-1 exits guard+create", async () => {
    const listCalls: string[] = [];
    let resolveFirstList!: (v: { items: [] }) => void;

    mockBatchListJobs
      .mockImplementationOnce(() => {
        listCalls.push("call-1");
        return new Promise<{ items: [] }>((resolve) => { resolveFirstList = resolve; });
      })
      .mockImplementation(() => {
        listCalls.push("call-2");
        return Promise.resolve({ items: [] });
      });

    const p1 = execute(makeCtx({ runId: "run-1" }));
    const p2 = execute(makeCtx({ runId: "run-2" }));

    // Drain microtasks: call-1 should be suspended in listNamespacedJob while
    // call-2 waits behind the per-agent mutex, not yet calling list.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(listCalls).toEqual(["call-1"]);

    // Let call-1's guard resolve (no running jobs). It will proceed to job
    // creation, fail (mock rejects), and release the mutex in finally.
    resolveFirstList({ items: [] });
    await Promise.allSettled([p1, p2]);

    // call-2 must have listed, and only AFTER call-1's guard resolved.
    // The exact order: call-1 listed → call-1 list resolved → call-2 listed.
    expect(listCalls).toEqual(["call-1", "call-2"]);
  });

  it("does not serialize guard phases for different agents", async () => {
    const listCalls: string[] = [];
    let resolveAgentAList!: (v: { items: [] }) => void;

    // Agent A's list is artificially slow. Agent B (different id) should
    // proceed immediately without waiting — the mutex is keyed by agent id.
    mockBatchListJobs
      .mockImplementationOnce(() => {
        listCalls.push("A");
        return new Promise<{ items: [] }>((resolve) => { resolveAgentAList = resolve; });
      })
      .mockImplementation(() => {
        listCalls.push("B");
        return Promise.resolve({ items: [] });
      });

    const ctxA = makeCtx({ runId: "run-A" });
    const ctxB = makeCtx({
      runId: "run-B",
      agent: { id: "agent-other", companyId: "co1", name: "Other Agent", adapterType: "claude_k8s", adapterConfig: {} },
    } as Partial<AdapterExecutionContext>);

    const pA = execute(ctxA);
    const pB = execute(ctxB);

    // Drain microtasks — B should have called list even though A is still
    // suspended, because they use separate mutex slots.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(listCalls).toContain("B");

    // Let A complete so the promises settle cleanly.
    resolveAgentAList({ items: [] });
    await Promise.allSettled([pA, pB]);
  });
});
