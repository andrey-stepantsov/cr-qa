import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const now = new Date();
const timestamp = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}-${String(now.getMinutes()).padStart(2,'0')}-${String(now.getSeconds()).padStart(2,'0')}`;

const reportsDir = path.resolve(__dirname, '../reports');
if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir);

const runDir = path.join(reportsDir, `${timestamp}_milestone1`);
fs.mkdirSync(runDir, { recursive: true });

console.log(`\n🚀 [QA Runner] Initializing Formal E2E Suite...`);
console.log(`📂 [QA Runner] Output Directory: ${runDir}`);

const res = spawnSync('npx', [
  'tsx', 'src/director.ts', runDir
], { 
  env: { ...process.env, COLUMNS: '120', LINES: '32', FORCE_COLOR: '1' }, 
  stdio: 'inherit' 
});

if (res.error) {
    console.error(`\n❌ [QA Runner] Execution failed: ${res.error.message}`);
} else {
    // Clone multi-casts to generic outputs/ for `npx serve`
    try {
        const outputsDir = path.resolve(__dirname, '../outputs');
        
        const filesToClone = ['alice.cast', 'bob.cast', 'edge.cast', 'admin.cast'];
        for (const f of filesToClone) {
            const src = path.join(runDir, f);
            if (fs.existsSync(src)) fs.copyFileSync(src, path.join(outputsDir, f));
        }
    } catch(e) {}
}

console.log(`\n✅ [QA Runner] Suite Finalized.`);
console.log(`📈 View the full synchronized playback and telemetry at:\nfile://${path.join(runDir, 'player.html')}\n`);
