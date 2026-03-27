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
  console.log("🎬 [Director] Starting Milestone 1 Organic Flow...");

  const testEnv = { 
    ...process.env, 
    FORCE_COLOR: '1',
    CR_DIR: `${process.env.HOME}/.cr`,
    CR_ADMIN_VAULT: path.resolve(CR_ROOT, '.keys/dev'),
    CR_BACKEND_URL: 'http://127.0.0.1:8787'
  };

  // 1. INCINERATOR: Drop local state completely (D1 + SQLite)
  console.log("🔥 [Incinerator] Dropping local ~/.cr state...");
  fs.rmSync(`${process.env.HOME}/.cr`, { recursive: true, force: true });
  
  console.log("🔥 [Incinerator] Dropping Edge D1 local states...");
  const workerWrangler = path.resolve(CR_ROOT, 'packages/cloudflare-worker/.wrangler');
  const adminWrangler = path.resolve(CR_ROOT, 'apps/admin-worker/.wrangler');
  fs.rmSync(workerWrangler, { recursive: true, force: true });
  fs.rmSync(adminWrangler, { recursive: true, force: true });
  
  await sleep(1000);

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
  const edgeCastStream = fs.createWriteStream(path.resolve(__dirname, '../outputs/edge_m1.cast'), { flags: 'w' });
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

  // Helper to spawn without pipe for fire and forget
  const spawnCli = (args: string[], name: string): ChildProcess => {
    console.log(`\n🤖 [Director:${name}] Executing \`cr-dev ${args.join(' ')}\``);
    const proc = spawn(CR_BIN, [...CR_ARGS, ...args], { env: testEnv, stdio: 'inherit' });
    return proc;
  };

  // 2. ADMIN PROVISIONING (Generate PKI Invite)
  console.log("\n[Director] Minting PKI invite token...");
  const adminProc = spawn(CR_BIN, [...CR_ARGS, 'admin', 'invite', 'test100@example.com'], { env: testEnv, stdio: 'pipe' });
  
  let adminOutput = '';
  adminProc.stdout.on('data', d => { adminOutput += d.toString(); process.stdout.write(d); });
  adminProc.stderr.on('data', d => process.stderr.write(d));
  
  await new Promise(r => adminProc.on('close', r));

  // Extract the token (last line or matched base64 string)
  const lines = adminOutput.trim().split('\n');
  const token = lines[lines.length - 1].trim();

  if (!token || !token.includes('.')) {
    console.error("❌ Failed to parse token from output.");
    workerProc.kill();
    process.exit(1);
  }

  // 3. USER SIMULATION (Activate & Chat)
  console.log(`\n👨‍💻 [Director:User] Connecting to ecosystem...`);
  const userChat = spawn(CR_BIN, [...CR_ARGS, 'chat'], { env: testEnv, stdio: 'pipe' });
  
  // Pipe output to terminal so asciinema captures it
  userChat.stdout.on('data', d => process.stdout.write(d));
  userChat.stderr.on('data', d => process.stderr.write(d));

  // Give the REPL a moment to initialize
  await sleep(3000);

  // Activate environment using the offline PKI token
  console.log(`\n[Director] Sending /activate...`);
  userChat.stdin.write(`/activate ${token}\n`);
  await sleep(4000);

  // Prompt Trinity
  console.log(`\n[Director] Sending natural language intent...`);
  userChat.stdin.write(`Hello @trinity, what is your capacity?\n`);
  
  // Wait for the AI generation to stream and complete
  await sleep(25000);

  // 4. ADMIN REVOCATION
  console.log(`\n[Director] Proving real-time killswitch (Revoking user)...\n`);
  spawnCli(['admin', 'users', 'revoke', 'test100@example.com'], 'AdminKillswitch');

  // Let the user process catch the revocation error
  await sleep(5000);

  // Cleanup
  userChat.stdin.write('/exit\n');
  await sleep(1000);
  userChat.kill();
  console.log("🛑 [Director] Shutting down isolated worker...");
  workerProc.kill();

  console.log("\\n🎬 [Director] Sequence Complete.");
  
  try {
     edgeCastStream.end();
  } catch (e) {}
}

runCliSequence().catch(e => {
  console.error(e);
  process.exit(1);
});
