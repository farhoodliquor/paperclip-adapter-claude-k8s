import type { AdapterModel } from "@paperclipai/adapter-utils";

export const type = "claude_k8s";
export const label = "Claude (Kubernetes)";

function isBedrockEnv(): boolean {
  return (
    process.env.CLAUDE_CODE_USE_BEDROCK === "1" ||
    process.env.CLAUDE_CODE_USE_BEDROCK === "true" ||
    (typeof process.env.ANTHROPIC_BEDROCK_BASE_URL === "string" &&
      process.env.ANTHROPIC_BEDROCK_BASE_URL.trim().length > 0)
  );
}

const DIRECT_MODELS: AdapterModel[] = [
  { id: "claude-opus-4-7", label: "Claude Opus 4.7" },
  { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4-6", label: "Claude Haiku 4.6" },
  { id: "claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
];

const BEDROCK_MODELS: AdapterModel[] = [
  { id: "us.anthropic.claude-opus-4-7", label: "Bedrock Opus 4.7" },
  { id: "us.anthropic.claude-opus-4-6-v1", label: "Bedrock Opus 4.6" },
  { id: "us.anthropic.claude-sonnet-4-6", label: "Bedrock Sonnet 4.6" },
  { id: "us.anthropic.claude-sonnet-4-5-20250929-v1:0", label: "Bedrock Sonnet 4.5" },
  { id: "us.anthropic.claude-haiku-4-5-20251001-v1:0", label: "Bedrock Haiku 4.5" },
];

export const models = isBedrockEnv() ? BEDROCK_MODELS : DIRECT_MODELS;

export const agentConfigurationDoc = `# claude_k8s agent configuration

Adapter: claude_k8s

Runs Claude Code inside an isolated Kubernetes Job pod instead of the main
Paperclip process. The Job inherits the container image, imagePullSecrets,
DNS config, and PVC from the running Paperclip Deployment automatically.

Core fields:
- model (string, optional): Claude model id
- effort (string, optional): reasoning effort passed via --effort (low|medium|high)
- maxTurnsPerRun (number, optional): max turns for one run
- instructionsFilePath (string, optional): absolute path to a markdown instructions file injected at runtime via --append-system-prompt-file
- extraArgs (string[], optional): additional CLI args appended to the claude command
- env (object, optional): KEY=VALUE environment variables; overrides inherited vars from the Deployment

Kubernetes fields:
- namespace (string, optional): namespace for Jobs; defaults to the Deployment namespace
- image (string, optional): override container image; defaults to the running Deployment image
- imagePullPolicy (string, optional): image pull policy; default "IfNotPresent"
- kubeconfig (string, optional): absolute path to a kubeconfig file on disk; defaults to in-cluster service account auth
- resources (object, optional): { requests: { cpu, memory }, limits: { cpu, memory } }
- nodeSelector (object, optional): node selector for Job pods
- tolerations (array, optional): tolerations for Job pods
- labels (object, optional): extra labels added to Job metadata
- ttlSecondsAfterFinished (number, optional): auto-cleanup delay; default 300
- retainJobs (boolean, optional): skip cleanup on completion for debugging
- reattachOrphanedJobs (boolean, optional): when true (default), attach to a running orphaned Job that matches the current agent/task/session instead of blocking; when false, any non-terminal orphan blocks the new run

Operational fields:
- timeoutSec (number, optional): run timeout in seconds; 0 means no timeout
- graceSec (number, optional): additional grace before adapter gives up after Job deadline

Inherited from Deployment (no config needed):
- ANTHROPIC_API_KEY, OPENAI_API_KEY, and other provider API keys
- PAPERCLIP_API_URL
- Container image, imagePullSecrets, DNS config, PVC mount, security context

Notes:
- Session resume works via the shared /paperclip PVC (HOME=/paperclip)
- Skills are bundled in the container image
- Prompts are delivered via a busybox init container writing to an emptyDir volume
`;

export { createServerAdapter } from "./server/index.js";
export { printClaudeStreamEvent } from "./cli/index.js";
