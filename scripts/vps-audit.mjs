import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportArgument = process.argv.slice(2).find((argument) => argument.startsWith('--report='));
const round = process.argv.includes('--round=2') ? 2 : 1;
const sizes = [1024, 512, 256, 128, 64, 32, 16, 8, 4, 2, 1];
const report = { date: new Date().toISOString(), platform: process.platform, node: process.version, round,
  interpretation: '2047 adversarial scenarios, not 2047 distinct defects or a frequency ranking', stages: [] };
for (const size of sizes) {
  const python = size === 32 || (round === 2 && (size === 4 || size === 2));
  const command = python ? (process.env.PAIR_NOTEBOOK_AGENT_PYTHON || (process.platform === 'win32' ? 'python' : 'python3')) : process.execPath;
  const file = round === 2 ? (size === 64 ? 'vpsComputeUi' : 'vpsAuditRound2')
    : size >= 128 || size === 16 || size === 8 ? 'vpsAuditMatrix' : size === 64 ? 'vpsComputeUi' : 'vpsCompute';
  const args = python ? ['test/vps_agent_audit.py', `${round === 2 ? 'Round2' : ''}Stage${size}`, '-q'] : [
    'node_modules/mocha/bin/mocha.js', '--timeout', '20000', '--exit', '--reporter', 'json',
    `out/test/${file}.test.js`, '--grep', round === 2 ? `^Round 2 Stage ${size}\\b` : `^(?!Round 2).*\\bStage ${size}\\b`,
  ];
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
  let stage;
  if (python) {
    const count = Number(/Ran (\d+) tests/.exec(result.stderr ?? '')?.[1] ?? 0);
    const pending = Number(/skipped=(\d+)/.exec(result.stderr ?? '')?.[1] ?? 0);
    const failures = Number(/failures=(\d+)/.exec(result.stderr ?? '')?.[1] ?? 0) + Number(/errors=(\d+)/.exec(result.stderr ?? '')?.[1] ?? 0);
    stage = { cases: size, tests: count, passes: count - failures - pending, failures: result.status === 0 ? 0 : failures || 1, pending };
  } else {
    try {
      const parsed = JSON.parse(result.stdout);
      stage = { cases: size, tests: parsed.stats.tests, passes: parsed.stats.passes, failures: parsed.stats.failures, pending: parsed.stats.pending };
      if (parsed.failures.length) process.stderr.write(parsed.failures.map((failure) => `${failure.fullTitle}: ${failure.err.message}`).join('\n') + '\n');
    } catch { stage = { cases: size, tests: 0, passes: 0, failures: 1, pending: 0 }; }
  }
  report.stages.push(stage);
  process.stdout.write(`Stage ${size}: ${stage.passes} passed, ${stage.failures} failed, ${stage.pending} skipped\n`);
  if (result.error || result.status !== 0 || stage.tests !== size) {
    if (python || stage.tests === 0) process.stderr.write((result.stderr || result.stdout || result.error?.message || 'Unexpected test count') + '\n');
    process.exitCode = 1; break;
  }
}
if (reportArgument) await writeFile(path.resolve(root, reportArgument.slice('--report='.length)), JSON.stringify(report, null, 2) + '\n');
