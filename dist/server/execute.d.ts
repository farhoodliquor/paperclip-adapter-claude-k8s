import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import type * as k8s from "@kubernetes/client-node";
/**
 * Detect a Kubernetes 404 (Not Found) error from @kubernetes/client-node.
 * Works for both v0.x (response.statusCode) and v1.0+ (response.status, message).
 * Exported for unit tests.
 */
export declare function isK8s404(err: unknown): boolean;
/**
 * Build the error message when Claude's stdout contains no result event.
 * Skips system/init event lines so the UI doesn't display the raw init JSON.
 * Exported for unit tests.
 */
export declare function buildPartialRunError(exitCode: number | null, model: string, stdout: string): string;
/**
 * Evaluate an orphaned K8s Job (one whose `paperclip.io/run-id` label does
 * not match the current runId) as a potential reattach target.  A Job is
 * reattachable when it belongs to the same agent, same task, and same resume
 * session as the current run — meaning the previous Paperclip instance was
 * mid-stream on the exact piece of work this new run was dispatched to do.
 * Exported for unit tests.
 */
export declare function isReattachableOrphan(job: k8s.V1Job, expected: {
    agentId: string;
    taskId: string | null;
    sessionId: string | null;
}): boolean;
/**
 * Build an error message for a pod that reached phase=Failed before or
 * instead of streaming logs. Includes the claude container's terminated exit
 * code and reason when available so operators can diagnose crashes without
 * needing kubectl.  Exported for unit tests.
 */
export declare function describePodTerminatedError(podName: string, phase: string, containerStatuses: k8s.V1ContainerStatus[]): string;
export declare function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult>;
//# sourceMappingURL=execute.d.ts.map