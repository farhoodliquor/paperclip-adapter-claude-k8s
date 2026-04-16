# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Paperclip adapter plugin that runs Claude Code agents as isolated Kubernetes Jobs instead of inside the main Paperclip process. It uses the `@kubernetes/client-node` library to interact with the K8s API.

## CI/CD

Build and publish are handled by GitHub Actions on tag push — do **not** build locally. To release a new version, bump `package.json` with `npm version` and push the tag — CI handles the rest.

## CI/CD

Build and publish are handled by GitHub Actions on tag push — do **not** build locally. To release a new version, bump `package.json` with `npm version` and push the tag — CI handles the rest.

## Common Commands

```bash
npm run typecheck # Type-check without emitting (local dev only)
npm test          # Run tests (vitest run)
npm run test:watch # Run tests in watch mode
npm run coverage   # Run tests with coverage
```

Do not run `npm run build` locally — it's run by the CI pipeline. To release: bump version (`npm version`), push, and CI publishes automatically.

Single test file: `npx vitest run src/server/execute.test.ts`

## Architecture

### Entry Point
`src/index.ts` exports `createServerAdapter()` which returns a `ServerAdapterModule` with all adapter capabilities. It re-exports types, models, and the execute function.

### Server Module (`src/server/`)
- **`execute.ts`** — Core execution flow: checks for concurrent runs, creates a K8s Job, waits for pod scheduling, streams logs, waits for job completion, parses Claude's stream-json output, and returns the result. Also handles cleanup and retention.
- **`job-manifest.ts`** — Builds the K8s Job manifest. Key design: an init container (busybox) writes the prompt to an emptyDir volume, then the main `claude` container reads it via stdin. The shared PVC is mounted at `/paperclip` with `HOME=/paperclip` to enable session resume.
- **`k8s-client.ts`** — Wrapper around `@kubernetes/client-node`. Caches the KubeConfig and self-pod introspection (`getSelfPodInfo`) which discovers the container image, imagePullSecrets, DNS config, PVC claim name, and env vars to forward to Job pods.
- **`config-schema.ts`** — Returns the UI config schema (typed as `ConfigFieldSchema[]`) that Paperclip's web UI renders as a form.
- **`parse.ts`** — Parses Claude's `stream-json` output format to extract session IDs, token usage, cost, and summaries.
- **`session.ts`** — Session codec for session resume.
- **`skills.ts`** / **`models.ts`** — Implement `listSkills`/`syncSkills` and `listModels` for the `ServerAdapterModule` interface.

### CLI Module (`src/cli/`)
- **`format-event.ts`** — Formats Claude stream events for terminal output.

### UI Parser (`src/ui-parser.ts`)
- Parses adapter-specific UI configuration fields.

### Config Schema Note
The types in `config-schema.ts` (`ConfigFieldSchema`) must match what Paperclip's `SchemaConfigFields` component expects, since Paperclip's server calls `adapter.getConfigSchema()` and the UI reads the JSON at runtime.

## Key Design Decisions

1. **Pod introspection** — On first `execute()` call, `getSelfPodInfo()` reads the running pod's spec via K8s API and caches it. Every subsequent Job inherits the Deployment's image, secrets, DNS, and PVC without additional config.

2. **Concurrency guard** — Before creating a Job, `execute.ts` lists existing Jobs labeled with the agent ID and blocks if any are still running (prevents session conflicts on the shared PVC).

3. **Prompt delivery** — The prompt is written by a busybox init container to an `emptyDir` volume, then read by the main `claude` container via `stdin`. This avoids escaping issues with env vars containing complex characters.

4. **Log streaming** — Uses `k8s.Log` follow mode with automatic reconnection. If the follow stream ends before the job completes (API disconnect), a one-shot log read is used as fallback.

5. **Session resume** — Works via the shared `/paperclip` PVC mounted as `HOME`. The `runtimeSessionId` is passed via `--resume` to the Claude CLI.
