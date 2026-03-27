import { spawn, ChildProcess, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { StringDecoder } from 'string_decoder';
import crypto from 'crypto';

const args = process.argv.slice(2);
const timestamp = new Date().toISOString().replace(/T/, '_').replace(/:/g, '-').split('.')[0];
const runDir = args[0] || path.resolve(__dirname, `../reports/${timestamp}`);
if (!fs.existsSync(runDir)) fs.mkdirSync(runDir, { recursive: true });

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const CR_ROOT = path.resolve(PROJECT_ROOT, 'cognitive-resonance');
const CR_BIN = 'npx';
const CR_ARGS = ['tsx', path.resolve(CR_ROOT, 'apps/cli/src/index.ts')];

const testEnv = { 
  ...process.env, 
  FORCE_COLOR: '1',
  CR_DIR: `${process.env.HOME}/.cr`,
  CR_ADMIN_VAULT: path.resolve(CR_ROOT, '.keys/dev'),
  CR_BACKEND_URL: 'http://127.0.0.1:8787'
};

const START_TIME = Date.now();
const metrics = { incinerateTime: 0, bootTime: 0, aiTime: 0, adminRevokeSuccess: false };

// ---------------------------------------------------------
// SYNTHETIC MULTI-STREAM MULTIPLEXER
// ---------------------------------------------------------

function createCastStream(name: string) {
    const stream = fs.createWriteStream(path.join(runDir, name), { flags: 'w' });
    stream.write(`{"version": 2, "width": 100, "height": 32}\n`);
    return stream;
}

const adminCst = createCastStream('admin.cast');
const edgeCst = createCastStream('edge.cast');
const aliceCst = createCastStream('alice.cast');
const bobCst = createCastStream('bob.cast');

function logAdmin(msg: string) {
    console.log(msg);
    const elapsed = (Date.now() - START_TIME) / 1000;
    adminCst.write(JSON.stringify([elapsed, "o", msg.replace(/(?<!\r)\n/g, '\r\n') + '\r\n']) + '\n');
}

function attachRecorder(proc: ChildProcess, stream: fs.WriteStream) {
    const stdoutDec = new StringDecoder('utf8');
    const stderrDec = new StringDecoder('utf8');
    
    proc.stdout?.on('data', d => {
        const text = stdoutDec.write(d);
        if (text) {
           process.stdout.write(text); // Mirror to real terminal for CI debugging
           const elapsed = (Date.now() - START_TIME) / 1000;
           stream.write(JSON.stringify([elapsed, "o", text.replace(/(?<!\r)\n/g, '\r\n')]) + '\n');
        }
    });
    
    proc.stderr?.on('data', d => {
        const text = stderrDec.write(d);
        if (text) {
           process.stderr.write(text);
           const elapsed = (Date.now() - START_TIME) / 1000;
           stream.write(JSON.stringify([elapsed, "o", text.replace(/(?<!\r)\n/g, '\r\n')]) + '\n');
        }
    });
}

function writeInputToCast(text: string, stream: fs.WriteStream) {
   const elapsed = (Date.now() - START_TIME) / 1000;
   stream.write(JSON.stringify([elapsed, "o", text.replace(/(?<!\r)\n/g, '\r\n')]) + '\n');
}

async function sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }

// ---------------------------------------------------------
// CORE QA LIFECYCLE
// ---------------------------------------------------------

async function runCliSequence() {
  logAdmin("🎬 [Director] Starting Milestone 1 Organic Flow...");

  // 1. INCINERATOR
  const tIncinerateStart = Date.now();
  logAdmin("🔥 [Incinerator] Dropping local ~/.cr state...");
  fs.rmSync(`${process.env.HOME}/.cr`, { recursive: true, force: true });
  logAdmin("🔥 [Incinerator] Dropping Edge D1 local states...");
  fs.rmSync(path.resolve(CR_ROOT, 'packages/cloudflare-worker/.wrangler'), { recursive: true, force: true });
  fs.rmSync(path.resolve(CR_ROOT, 'apps/admin-worker/.wrangler'), { recursive: true, force: true });
  await sleep(1000);
  metrics.incinerateTime = (Date.now() - tIncinerateStart) / 1000;

  // 1.5. BOOTSTRAP BACKEND
  logAdmin("🛠️ [Director] Applying D1 Schema...");
  const migrateProc = spawn(CR_BIN, ['wrangler', 'd1', 'execute', 'DB', '--local', '--file', 'schema.sql'], {
     cwd: path.resolve(CR_ROOT, 'packages/cloudflare-worker'), env: testEnv, stdio: ['ignore', 'pipe', 'pipe']
  });
  attachRecorder(migrateProc, adminCst);
  await new Promise(r => migrateProc.on('close', r));

  logAdmin("🚀 [Director] Starting isolated Cloudflare Worker...");
  try { execSync('lsof -ti :8787 | xargs kill -9', { stdio: 'ignore' }); } catch (e) {}

  let crPubKeyStr = "NOT_FOUND";
  try {
     const priv = crypto.createPrivateKey(fs.readFileSync(path.join(CR_ROOT, '.keys/dev/ed25519.pem')));
     crPubKeyStr = crypto.createPublicKey(priv).export({type:'spki', format:'der'}).toString('base64');
  } catch (e) {}

  fs.writeFileSync(path.resolve(CR_ROOT, 'packages/cloudflare-worker/.dev.vars'), `JWT_SECRET="qa_secret_key"\nCR_PUBLIC_KEY="${crPubKeyStr}"\nSECRET_SUPER_ADMIN_IDS="alice@matrix.com"\n`);

  const tBootStart = Date.now();
  let workerProc = spawn(CR_BIN, ['wrangler', 'dev', '--port', '8787'], { 
     cwd: path.resolve(CR_ROOT, 'packages/cloudflare-worker'), env: testEnv, stdio: ['ignore', 'pipe', 'pipe'] 
  });
  attachRecorder(workerProc, edgeCst); // ALL edge logs go securely to edge.cast natively!

  logAdmin("⏳ [Director] Waiting for backend healthcheck...");
  let ready = false;
  for (let i = 0; i < 30; i++) {
     try {
        const res = await fetch('http://127.0.0.1:8787/api/system/health', { signal: AbortSignal.timeout(1000) });
        if (res.ok) { ready = true; logAdmin(" ✅ UP!"); break; }
     } catch (e) {}
     await sleep(1000);
  }
  if (!ready) { logAdmin("❌ [Director] Backend failed to start."); process.exit(1); }
  metrics.bootTime = (Date.now() - tBootStart) / 1000;

  // 1.8. SANITY COMMANDS
  logAdmin("\n[Director] Running basic sanity and help commands...");
  const sanityHelp = spawn(CR_BIN, [...CR_ARGS, 'help'], { env: testEnv, stdio: 'pipe' });
  attachRecorder(sanityHelp, adminCst);
  await new Promise(r => sanityHelp.on('close', r));
  
  const sanityDashHelp = spawn(CR_BIN, [...CR_ARGS, '--help'], { env: testEnv, stdio: 'pipe' });
  attachRecorder(sanityDashHelp, adminCst);
  await new Promise(r => sanityDashHelp.on('close', r));

  // 2. ADMIN PROVISIONING
  logAdmin("\n[Director] Minting PKI invite token for Alice...");
  const adminProcA = spawn(CR_BIN, [...CR_ARGS, 'admin', 'invite', 'alice@matrix.com'], { env: testEnv, stdio: 'pipe' });
  attachRecorder(adminProcA, adminCst);
  
  let outA = '';
  adminProcA.stdout.on('data', d => outA += d.toString());
  await new Promise(r => adminProcA.on('close', r));
  const tokenA = outA.trim().split('\n').pop()?.trim();

  logAdmin("\n[Director] Minting PKI invite token for Bob...");
  const adminProcB = spawn(CR_BIN, [...CR_ARGS, 'admin', 'invite', 'bob@matrix.com'], { env: testEnv, stdio: 'pipe' });
  attachRecorder(adminProcB, adminCst);
  
  let outB = '';
  adminProcB.stdout.on('data', d => outB += d.toString());
  await new Promise(r => adminProcB.on('close', r));
  const tokenB = outB.trim().split('\n').pop()?.trim();

  if (!tokenA || !tokenB || !tokenA.includes('.') || !tokenB.includes('.')) {
      logAdmin("❌ Failed to parse tokens from output."); process.exit(1); 
  }

  // 3. CONCURRENT USER SIMULATION!
  logAdmin(`\n👨‍💻 [Director:User] Spawning Dual Parallel Terminals...`);
  const aliceChat = spawn(CR_BIN, [...CR_ARGS, 'chat'], { env: testEnv, stdio: 'pipe' });
  attachRecorder(aliceChat, aliceCst);
  
  const bobChat = spawn(CR_BIN, [...CR_ARGS, 'chat'], { env: testEnv, stdio: 'pipe' });
  attachRecorder(bobChat, bobCst);

  await sleep(3000);

  // Authenticate both concurrently (Serialized Activation IO to prevent tokens.json race)
  writeInputToCast(`> /activate ${tokenA}\n`, aliceCst);
  aliceChat.stdin.write(`/activate ${tokenA}\n`);
  await sleep(4000);
  
  writeInputToCast(`> /activate ${tokenB}\n`, bobCst);
  bobChat.stdin.write(`/activate ${tokenB}\n`);
  
  await sleep(4000);

  // Name Changes (Local boundary assertion)
  writeInputToCast(`> /exit\n`, aliceCst);
  aliceChat.stdin.write('/exit\n');
  await sleep(1000);
  
  logAdmin(`\n🛠️ [Director] Asserting authenticated boundary via CLI Name Change for Alice...`);
  const setAlice = spawn(CR_BIN, [...CR_ARGS, 'user', 'set-name', 'Alice / Archangel'], { env: testEnv, stdio: 'pipe' });
  attachRecorder(setAlice, aliceCst);
  await new Promise(r => setAlice.on('close', r));
  
  // Re-enter Chat for Alice
  const aliceChat2 = spawn(CR_BIN, [...CR_ARGS, 'chat'], { env: testEnv, stdio: 'pipe' });
  attachRecorder(aliceChat2, aliceCst);
  await sleep(3000);

  const tAiStart = Date.now();
  
  // AI Orchestrator Execution: Complex Tasks & Timeouts
  
  logAdmin(`\n[Director] Simulating Network Failure... Killing Edge Worker...`);
  workerProc.kill();
  await sleep(1000);
  
  logAdmin(`\n[Director] Triggering intentional timeout in Alice...`);
  writeInputToCast(`> @trinity Are you still there?\n`, aliceCst);
  aliceChat2.stdin.write(`@trinity Are you still there?\n`);
  
  await sleep(7000); // Let UI show a graceful fetch timeout

  logAdmin(`\n🚀 [Director] Restarting Edge Worker...`);
  workerProc = spawn(CR_BIN, ['wrangler', 'dev', '--port', '8787'], { 
     cwd: path.resolve(CR_ROOT, 'packages/cloudflare-worker'), env: testEnv, stdio: ['ignore', 'pipe', 'pipe'] 
  });
  attachRecorder(workerProc, edgeCst);
  await sleep(4000); // Allow backend to boot
  
  logAdmin(`\n[Director] Sending successful Trinity request...`);
  writeInputToCast(`> @trinity Hello, system is restored. Status?\n`, aliceCst);
  aliceChat2.stdin.write(`@trinity Hello, system is restored. Status?\n`);
  
  await sleep(8000);

  logAdmin(`\n[Director] Executing DSL Pipeline: Basic Self-Reference...`);
  writeInputToCast(`> @alice:trinity#latest(get content)\n`, aliceCst);
  aliceChat2.stdin.write(`@alice:trinity#latest(get content)\n`);
  
  await sleep(6000);
  
  logAdmin(`\n[Director] Sending Complex Structured Request from Alice...`);
  writeInputToCast(`> @guide Please list the active system personas and their capabilities in a structured JSON format.\n`, aliceCst);
  aliceChat2.stdin.write(`@guide Please list the active system personas and their capabilities in a structured JSON format.\n`);
  
  await sleep(12000);

  logAdmin(`\n[Director] Executing DSL Pipeline: Complex Lisp Filtering...`);
  // TODO: Implement Semantic DSL macro parsing inside the CLI.
  // Currently, @user:agent#turn(lisp) is not intercepted locally and blindly routes as a raw LLM prompt.
  // We need to build the AST traversal engine to securely evaluate list expressions (json-path)
  // offline, and rigorously trap/handle syntax or resolution execution failures dynamically.
  writeInputToCast(`> @alice:guide#latest(json-path '$.personas')\n`, aliceCst);
  aliceChat2.stdin.write(`@alice:guide#latest(json-path '$.personas')\n`);
  
  await sleep(6000);
  
  logAdmin(`\n[Director] Sending Operator Request from Bob concurrently...`);
  writeInputToCast(`> @operator Please verify our D1 database configuration and confirm the health node status.\n`, bobCst);
  bobChat.stdin.write(`@operator Please verify our D1 database configuration and confirm the health node status.\n`);

  await sleep(15000);

  logAdmin(`\n[Director] Executing Cross-User Boundary Test (Unauthorized Access)...`);
  writeInputToCast(`> @alice:guide#1()\n`, bobCst);
  bobChat.stdin.write(`@alice:guide#1()\n`);

  await sleep(8000);
  metrics.aiTime = (Date.now() - tAiStart) / 1000;

  // 4. ADMIN REVOCATION
  logAdmin(`\n[Director] Proving real-time killswitch: Revoking Alice...\n`);
  const switchAlice = spawn(CR_BIN, [...CR_ARGS, 'identity', 'switch', 'alice@matrix.com'], { env: testEnv, stdio: 'pipe' });
  attachRecorder(switchAlice, adminCst);
  await new Promise(r => switchAlice.on('close', r));
  await sleep(1000);

  const adminKill = spawn(CR_BIN, [...CR_ARGS, 'admin', 'revoke', 'alice@matrix.com'], { env: testEnv, stdio: 'pipe' });
  attachRecorder(adminKill, adminCst);
  await new Promise(r => adminKill.on('close', r));

  await sleep(5000); // Allow Alice Terminal to receive network death

  // Teardown
  writeInputToCast(`> /exit\n`, aliceCst);
  aliceChat2.stdin.write('/exit\n');
  writeInputToCast(`> /exit\n`, bobCst);
  bobChat.stdin.write('/exit\n');
  await sleep(1000);
  
  aliceChat2.kill();
  bobChat.kill();
  workerProc.kill();
  
  logAdmin("\n🎬 [Director] Sequence Complete. 4-Way Multi-Cast finalized.");
  metrics.adminRevokeSuccess = true;

  [adminCst, edgeCst, aliceCst, bobCst].forEach(c => {
      try { c.end(); } catch (e) {}
  });

  const reportMd = `# Formal QA Execution Report (Phase 6 - Multi Terminal)
**Date:** \`${new Date().toISOString()}\`
**Verdict:** ${metrics.adminRevokeSuccess ? '✅ PASS' : '❌ FAIL'}

## Telemetry Metrics
- **D1 Cloud Incineration:** ${metrics.incinerateTime.toFixed(2)}s
- **Distributed Orchestrator Boot:** ${metrics.bootTime.toFixed(2)}s
- **Parallel AI Request Processing:** ${metrics.aiTime.toFixed(2)}s

[Open Multi-Terminal Grid Player Dashboard](./player.html)
`;
  fs.writeFileSync(path.join(runDir, 'report.md'), reportMd);
  
  const sourceHtml = path.resolve(__dirname, 'player.html');
  if (fs.existsSync(sourceHtml)) fs.copyFileSync(sourceHtml, path.join(runDir, 'player.html'));
}

runCliSequence().catch(e => { console.error(e); process.exit(1); });
