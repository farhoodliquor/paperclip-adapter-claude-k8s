import type { AdapterModel } from "@paperclipai/adapter-utils";
import { models as DIRECT_MODELS } from "../index.js";

const BEDROCK_MODELS: AdapterModel[] = [
  { id: "us.anthropic.claude-opus-4-6-v1", label: "Bedrock Opus 4.6" },
  { id: "us.anthropic.claude-sonnet-4-5-20250929-v2:0", label: "Bedrock Sonnet 4.5" },
  { id: "us.anthropic.claude-haiku-4-5-20251001-v1:0", label: "Bedrock Haiku 4.5" },
];

function isBedrockEnv(): boolean {
  return (
    process.env.CLAUDE_CODE_USE_BEDROCK === "1" ||
    process.env.CLAUDE_CODE_USE_BEDROCK === "true" ||
    (typeof process.env.ANTHROPIC_BEDROCK_BASE_URL === "string" &&
      process.env.ANTHROPIC_BEDROCK_BASE_URL.trim().length > 0)
  );
}

export async function listK8sModels(): Promise<AdapterModel[]> {
  return isBedrockEnv() ? BEDROCK_MODELS : DIRECT_MODELS;
}
