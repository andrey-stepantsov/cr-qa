# Cognitive Resonance E2E QA (`cr-qa`)

## Overview
The `cr-qa` workspace houses the automated end-to-end (E2E) testing harness for the Cognitive Resonance ecosystem. It leverages a headless `terminal-director` pattern to programmatically orchestrate the CLI, spin up local Cloudflare Edge workers, and simulate organic user-agent interactions without manual human intervention.

## Core Execution Flow 
The primary execution sequence (`director.ts`) implements the following hermetic lifecycle:

1. **The Incinerator (State Purge):** Prior to each execution, the script forcibly deletes local SQLite (`~/.cr`) and D1/Edge storage states (`.wrangler` directories) to guarantee a greenfield testing environment.
2. **Edge Bootstrap:** Spawns an isolated `wrangler dev` instance and strictly polls the `/api/system/health` endpoint until the backend is fully stabilized.
3. **Admin Provisioning:** Simulates an administrator executing `cr-dev admin invite` to cryptographically mint a deterministic offline identity token (Ed25519 PKI).
4. **User Simulation:** Programmatically pipes text into `cr-dev chat`. It securely authenticates the environment via `/activate <token>`, and executes complex organic prompts against the `@trinity` AI orchestrator.
5. **Real-Time Revocation:** Simulates a live administrative intervention by executing `cr-dev admin users revoke`, successfully proving the ecosystem's architectural killswitch by tearing down the user's active connection mid-flight.

## Multi-Terminal Session Player
Testing a disjointed Operating Environment (where logic spans both a Local Client and a Serverless Edge) requires deterministic observability across multiple machines.

To provide a professional-grade, human-reviewable QA environment, the QA script captures both sides of the network as independent `asciinema` recordings:
1. `outputs/m1.cast`: Standard output representing the **Client REPL**.
2. `outputs/edge_m1.cast`: The asynchronous worker logs representing the **Edge Daemon**.

These logs are brought together in the **Multi-Terminal Session Player** (`outputs/player.html`). 

### Player Features
The HTML dashboard leverages `asciinema-player` to render both terminal sessions side-by-side:
- **Synchronized Playback:** Transport controls (Play, Pause, Restart) are fundamentally bound to both players, ensuring the Client's prompt aligns perfectly in time with the Edge's subsequent computation logs.
- **Granular Navigation:** Frame-stepping (`<`, `>`), speed control (`0.25x` to `8.0x`), and precise time scrubbing.
- **Customized Theming:** Distinct terminal themes (Monokai for Client, Dracula for Edge) easily distinguish the T1 and T2 architecture layers.

## Usage
To execute the primary flow and generate synchronized artifacts, run the E2E NPM script:
```bash
npm install
npm run test:milestone1
```
Once complete, open `outputs/player.html` in your browser to observe the synchronized telemetry.
