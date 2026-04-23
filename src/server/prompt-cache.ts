import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import {
  type PaperclipSkillEntry,
  ensurePaperclipSkillSymlink,
} from "@paperclipai/adapter-utils/server-utils";

export interface ClaudePromptBundle {
  bundleKey: string;
  /** Absolute path to the bundle root directory (contains .claude/skills/ and agent-instructions.md). */
  rootDir: string;
  /** Value to pass as --add-dir to the Claude CLI. */
  addDir: string;
  /** Path to the materialized instructions file, or null if no instructions were provided. */
  instructionsFilePath: string | null;
}

const DEFAULT_PAPERCLIP_INSTANCE_ID = "default";

function validatePathComponent(value: string, fieldName: string): void {
  if (value.trim().length === 0) throw new Error(`Invalid ${fieldName}: must not be empty`);
  if (value.includes("/") || value.includes("\\")) throw new Error(`Invalid ${fieldName}: must not contain path separators`);
  if (value.includes("..")) throw new Error(`Invalid ${fieldName}: must not contain ".."`);
  if (value.includes("\0")) throw new Error(`Invalid ${fieldName}: must not contain null bytes`);
}

function resolveManagedClaudePromptCacheRoot(companyId: string): string {
  const paperclipHome =
    (typeof process.env.PAPERCLIP_HOME === "string" && process.env.PAPERCLIP_HOME.trim().length > 0
      ? process.env.PAPERCLIP_HOME.trim()
      : null) ??
    path.resolve(os.homedir(), ".paperclip");
  const instanceId =
    (typeof process.env.PAPERCLIP_INSTANCE_ID === "string" && process.env.PAPERCLIP_INSTANCE_ID.trim().length > 0
      ? process.env.PAPERCLIP_INSTANCE_ID.trim()
      : null) ?? DEFAULT_PAPERCLIP_INSTANCE_ID;
  validatePathComponent(companyId, "companyId");
  validatePathComponent(instanceId, "instanceId");
  return path.resolve(paperclipHome, "instances", instanceId, "companies", companyId, "claude-prompt-cache");
}

async function hashPathContents(
  candidate: string,
  hash: ReturnType<typeof createHash>,
  relativePath: string,
  seenDirectories: Set<string>,
): Promise<void> {
  const stat = await fs.lstat(candidate);
  if (stat.isSymbolicLink()) {
    hash.update(`symlink:${relativePath}\n`);
    const resolved = await fs.realpath(candidate).catch(() => null);
    if (!resolved) {
      hash.update("missing\n");
      return;
    }
    await hashPathContents(resolved, hash, relativePath, seenDirectories);
    return;
  }
  if (stat.isDirectory()) {
    const realDir = await fs.realpath(candidate).catch(() => candidate);
    hash.update(`dir:${relativePath}\n`);
    if (seenDirectories.has(realDir)) {
      hash.update("loop\n");
      return;
    }
    seenDirectories.add(realDir);
    const entries = await fs.readdir(candidate, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const childRelativePath = relativePath.length > 0 ? `${relativePath}/${entry.name}` : entry.name;
      await hashPathContents(path.join(candidate, entry.name), hash, childRelativePath, seenDirectories);
    }
    return;
  }
  if (stat.isFile()) {
    hash.update(`file:${relativePath}\n`);
    hash.update(await fs.readFile(candidate));
    hash.update("\n");
    return;
  }
  hash.update(`other:${relativePath}:${stat.mode}\n`);
}

async function buildClaudePromptBundleKey(input: {
  skills: PaperclipSkillEntry[];
  instructionsContents: string | null;
}): Promise<string> {
  const hash = createHash("sha256");
  hash.update("paperclip-claude-prompt-bundle:v1\n");
  if (input.instructionsContents) {
    hash.update("instructions\n");
    hash.update(input.instructionsContents);
    hash.update("\n");
  } else {
    hash.update("instructions:none\n");
  }
  const sortedSkills = [...input.skills].sort((a, b) => a.runtimeName.localeCompare(b.runtimeName));
  for (const entry of sortedSkills) {
    hash.update(`skill:${entry.key}:${entry.runtimeName}\n`);
    await hashPathContents(entry.source, hash, entry.runtimeName, new Set());
  }
  return hash.digest("hex");
}

async function ensureReadableFile(targetPath: string, contents: string): Promise<void> {
  try {
    await fs.access(targetPath, fsConstants.R_OK);
    return;
  } catch {
    // Fall through and materialize the file.
  }
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tempPath, contents, "utf8");
    await fs.rename(tempPath, targetPath);
  } catch (err) {
    const targetReadable = await fs.access(targetPath, fsConstants.R_OK).then(() => true).catch(() => false);
    if (!targetReadable) throw err;
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

export async function prepareClaudePromptBundle(input: {
  companyId: string;
  skills: PaperclipSkillEntry[];
  instructionsContents: string | null;
  onLog: AdapterExecutionContext["onLog"];
}): Promise<ClaudePromptBundle> {
  const { companyId, skills, instructionsContents, onLog } = input;
  const bundleKey = await buildClaudePromptBundleKey({ skills, instructionsContents });
  const rootDir = path.join(resolveManagedClaudePromptCacheRoot(companyId), bundleKey);
  const skillsHome = path.join(rootDir, ".claude", "skills");
  await fs.mkdir(skillsHome, { recursive: true });

  for (const entry of skills) {
    const target = path.join(skillsHome, entry.runtimeName);
    try {
      await ensurePaperclipSkillSymlink(entry.source, target);
    } catch (err) {
      await onLog(
        "stderr",
        `[paperclip] Failed to materialize Claude skill "${entry.key}" into ${skillsHome}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  const instructionsFilePath = instructionsContents ? path.join(rootDir, "agent-instructions.md") : null;
  if (instructionsFilePath && instructionsContents) {
    await ensureReadableFile(instructionsFilePath, instructionsContents);
  }

  return { bundleKey, rootDir, addDir: rootDir, instructionsFilePath };
}
