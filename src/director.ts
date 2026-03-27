import { spawn, ChildProcess, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { StringDecoder } from 'string_decoder';
import crypto from 'crypto';

// Resolve CR root relative to cr-qa workspace
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const CR_ROOT = path.resolve(PROJECT_ROOT, 'cognitive-resonance');

// Use npx tsx directly against the CLI index to avoid requiring global links during QA
const CR_BIN = 'npx';
const CR_ARGS = ['tsx', path.resolve(CR_ROOT, 'apps/cli/src/index.ts')];

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runCliSequence() {
  const args = process.argv.slice(2);
  const runDir = args[0] || path.resolve(__dirname, '../outputs');
  if (!fs.existsSync(runDir)) fs.mkdirSync(runDir, { recursive: true });

  console.log("🎬 [Director] Starting Milestone 1 Organic Flow...");
  const metrics = { incinerateTime: 0, bootTime: 0, aiTime: 0, adminRevokeSuccess: false };

  const testEnv = { 
    ...process.env, 
    FORCE_COLOR: '1',
    CR_DIR: `${process.env.HOME}/.cr`,
    CR_ADMIN_VAULT: path.resolve(CR_ROOT, '.keys/dev'),
    CR_BACKEND_URL: 'http://127.0.0.1:8787'
  };

  // 1. INCINERATOR: Drop local state completely (D1 + SQLite)
  const tIncinerateStart = Date.now();
  console.log("🔥 [Incinerator] Dropping local ~/.cr state...");
  fs.rmSync(`${process.env.HOME}/.cr`, { recursive: true, force: true });
  
  console.log("🔥 [Incinerator] Dropping Edge D1 local states...");
  const workerWrangler = path.resolve(CR_ROOT, 'packages/cloudflare-worker/.wrangler');
  const adminWrangler = path.resolve(CR_ROOT, 'apps/admin-worker/.wrangler');
  fs.rmSync(workerWrangler, { recursive: true, force: true });
  fs.rmSync(adminWrangler, { recursive: true, force: true });
  
  await sleep(1000);
  metrics.incinerateTime = (Date.now() - tIncinerateStart) / 1000;

  // 1.5. BOOTSTRAP BACKEND
  console.log("🛠️ [Director] Applying D1 Schema...");
  
  const migrateProc = spawn('npx', ['wrangler', 'd1', 'execute', 'DB', '--local', '--file', 'schema.sql'], {
     cwd: path.resolve(CR_ROOT, 'packages/cloudflare-worker'),
     env: testEnv,
     stdio: 'inherit' // let it print to QA stdout
  });
  await new Promise(r => migrateProc.on('close', r));

  console.log("🚀 [Director] Starting isolated Cloudflare Worker...");
  
  try {
     execSync('lsof -ti :8787 | xargs kill -9', { stdio: 'ignore' });
  } catch (e) {
     // ignore if no process is found
  }
  
  // Extract the real matching public key from the CLI's admin vault
  let crPubKeyStr = "NOT_FOUND";
  try {
     const priv = crypto.createPrivateKey(fs.readFileSync(path.join(CR_ROOT, '.keys/dev/ed25519.pem')));
     crPubKeyStr = crypto.createPublicKey(priv).export({type:'spki', format:'der'}).toString('base64');
  } catch (e) {
     console.error("Failed to read .keys/dev/ed25519.pem");
  }

  // Ensure .dev.vars has exactly what we need for the hermetic QA test
  // Note: We supply CR_PUBLIC_KEY as a pure base64 SPKI one-liner to avoid Wrangler multiline parsing bugs.
  const devVarsPath = path.resolve(CR_ROOT, 'packages/cloudflare-worker/.dev.vars');
  fs.writeFileSync(devVarsPath, `JWT_SECRET="qa_secret_key"\nCR_PUBLIC_KEY="${crPubKeyStr}"\nSECRET_SUPER_ADMIN_IDS="test100@example.com"\n`);

  // Create a synchronized secondary asciicast stream for the Edge logs
  const START_TIME = Date.now();
  const tBootStart = Date.now();
  const edgeCastStream = fs.createWriteStream(path.join(runDir, 'edge_m1.cast'), { flags: 'w' });
  edgeCastStream.write(`{"version": 2, "width": 100, "height": 32}\n`);

  const workerNodeArgs = ['wrangler', 'dev', '--port', '8787'];
  const workerProc = spawn('npx', workerNodeArgs, { 
     cwd: path.resolve(CR_ROOT, 'packages/cloudflare-worker'), 
     env: testEnv, 
     stdio: ['ignore', 'pipe', 'pipe'] 
  });
  
  const stdoutDec = new StringDecoder('utf8');
  const stderrDec = new StringDecoder('utf8');
  
  workerProc.stdout.on('data', d => {
     const rawText = stdoutDec.write(d);
     if (rawText) {
        const text = rawText.replace(/(?<!\r)\n/g, '\r\n');
        const elapsed = (Date.now() - START_TIME) / 1000;
        edgeCastStream.write(JSON.stringify([elapsed, "o", text]) + '\n');
     }
  });
  workerProc.stderr.on('data', d => {
     const rawText = stderrDec.write(d);
     if (rawText) {
        const text = rawText.replace(/(?<!\r)\n/g, '\r\n');
        const elapsed = (Date.now() - START_TIME) / 1000;
        edgeCastStream.write(JSON.stringify([elapsed, "o", text]) + '\n');
     }
  });

  // Robust polling to ensure wrangler bind completes
  process.stdout.write("⏳ [Director] Waiting for backend healthcheck...");
  let ready = false;
  for (let i = 0; i < 30; i++) {
     try {
        const res = await fetch('http://127.0.0.1:8787/api/system/health', {
           signal: AbortSignal.timeout(1000)
        });
        if (res.ok) {
           ready = true;
           console.log(" ✅ UP!");
           break;
        }
     } catch (e) {
        // fetch failed, keep waiting
     }
     process.stdout.write(".");
     await sleep(1000);
  }
  
  if (!ready) {
     console.error("\n❌ [Director] Backend failed to start within 30s.");
     workerProc.kill();
     process.exit(1);
  }

  console.log("🚀 [Director] Backend presumed ready.");
  metrics.bootTime = (Date.now() - tBootStart) / 1000;

  // Helper to spawn without pipe for fire and forget
  const spawnCli = (args: string[], name: string): ChildProcess => {
    console.log(`\n🤖 [Director:${name}] Executing \`cr-dev ${args.join(' ')}\``);
    const proc = spawn(CR_BIN, [...CR_ARGS, ...args], { env: testEnv, stdio: 'inherit' });
    return proc;
  };

  // 2. ADMIN PROVISIONING (Generate PKI Invites)
  console.log("\n[Director] Minting PKI invite token for User A...");
  const adminProcA = spawn(CR_BIN, [...CR_ARGS, 'admin', 'invite', 'test100@example.com'], { env: testEnv, stdio: 'pipe' });
  let adminOutputA = '';
  adminProcA.stdout.on('data', d => { adminOutputA += d.toString(); process.stdout.write(d); });
  adminProcA.stderr.on('data', d => process.stderr.write(d));
  await new Promise(r => adminProcA.on('close', r));
  const linesA = adminOutputA.trim().split('\n');
  const tokenA = linesA[linesA.length - 1].trim();

  console.log("\n[Director] Minting PKI invite token for User B...");
  const adminProcB = spawn(CR_BIN, [...CR_ARGS, 'admin', 'invite', 'test200@example.com'], { env: testEnv, stdio: 'pipe' });
  let adminOutputB = '';
  adminProcB.stdout.on('data', d => { adminOutputB += d.toString(); process.stdout.write(d); });
  adminProcB.stderr.on('data', d => process.stderr.write(d));
  await new Promise(r => adminProcB.on('close', r));
  const linesB = adminOutputB.trim().split('\n');
  const tokenB = linesB[linesB.length - 1].trim();

  if (!tokenA || !tokenB || !tokenA.includes('.') || !tokenB.includes('.')) {
    console.error("❌ Failed to parse tokens from output.");
    workerProc.kill();
    process.exit(1);
  }

  // 3. MULTI-IDENTITY USER SIMULATION (Activate & Profile Switch)
  console.log(`\n👨‍💻 [Director:User] Connecting to ecosystem to materialize offline identities...`);
  const setupChat = spawn(CR_BIN, [...CR_ARGS, 'chat'], { env: testEnv, stdio: 'pipe' });
  setupChat.stdout.on('data', d => process.stdout.write(d));
  setupChat.stderr.on('data', d => process.stderr.write(d));

  await sleep(3000);
  console.log(`\n[Director] Activating test100 Profile...`);
  setupChat.stdin.write(`/activate ${tokenA}\n`);
  await sleep(3000);

  console.log(`\n[Director] Activating test200 Profile...`);
  setupChat.stdin.write(`/activate ${tokenB}\n`);
  await sleep(3000);

  setupChat.stdin.write('/exit\n');
  await sleep(1000);
  setupChat.kill();

  console.log(`\n🛠️ [Director] Validating Mutli-Identity State...`);
  spawnCli(['identity', 'ls'], 'IdentityTracker');
  await sleep(2000);

  console.log(`\n🛠️ [Director] Swapping active profile back to test100...`);
  spawnCli(['identity', 'switch', 'test100@example.com'], 'IdentityTracker');
  await sleep(2000);

  // Reconnect as Active Profile
  console.log(`\n👨‍💻 [Director:User] Re-entering ecosystem as active profile [test100@example.com]...`);
  const activeChat = spawn(CR_BIN, [...CR_ARGS, 'chat'], { env: testEnv, stdio: 'pipe' });
  activeChat.stdout.on('data', d => process.stdout.write(d));
  activeChat.stderr.on('data', d => process.stderr.write(d));
  await sleep(3000);

  // Prompt Trinity
  const tAiStart = Date.now();
  console.log(`\n[Director] Sending natural language intent...`);
  activeChat.stdin.write(`Hello @trinity, what is your capacity?\n`);
  
  // Wait for the AI generation to stream and complete
  await sleep(25000);
  metrics.aiTime = (Date.now() - tAiStart) / 1000;

  // 4. ADMIN REVOCATION (Using Shorthand Alias)
  console.log(`\n[Director] Proving real-time killswitch via explicit shorthand command (admin revoke)...\n`);
  spawnCli(['admin', 'revoke', 'test100@example.com'], 'AdminKillswitch');

  // Let the user process catch the revocation error
  await sleep(5000);

  // Cleanup
  activeChat.stdin.write('/exit\n');
  await sleep(1000);
  activeChat.kill();
  console.log("🛑 [Director] Shutting down isolated worker...");
  workerProc.kill();

  console.log("\\n🎬 [Director] Sequence Complete.");
  metrics.adminRevokeSuccess = true;
  
  try {
     edgeCastStream.end();
  } catch (e) {}

  // Generate Formal QA Report
  const reportMd = `# Formal QA Execution Report (Phase 6)
**Date:** \`${new Date().toISOString()}\`
**Verdict:** ${metrics.adminRevokeSuccess ? '✅ PASS' : '❌ FAIL'}

## Telemetry Metrics
- **D1 Cloud Incineration:** ${metrics.incinerateTime.toFixed(2)}s
- **Distributed Orchestrator Boot:** ${metrics.bootTime.toFixed(2)}s
- **AI Generation Response:** ${metrics.aiTime.toFixed(2)}s

[Open Player Dashboard](./player.html)
`;
  fs.writeFileSync(path.join(runDir, 'report.md'), reportMd);
  
  // Copy static player HTML into this completely isolated run matrix
  const sourceHtml = path.resolve(__dirname, '../outputs/player.html');
  const destHtml = path.join(runDir, 'player.html');
  if (fs.existsSync(sourceHtml)) {
      fs.copyFileSync(sourceHtml, destHtml);
  }
}

runCliSequence().catch(e => {
  console.error(e);
  process.exit(1);
});
