import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'mocha';
import { pythonNotebookProgram } from '../src/vps/notebookProgram';

describe('VPS notebook execution', () => {
  let directory: string;
  beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), 'pair-vps-notebook-')); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
  async function execute(cells: string[], isolated = true): Promise<ReturnType<typeof spawnSync>> {
    const filename = path.join(directory, 'notebook.py');
    await writeFile(filename, pythonNotebookProgram(cells));
    return spawnSync('python3', [...(isolated ? ['-I', '-S'] : []), filename], { encoding: 'utf8', timeout: 10_000 });
  }
  it('preserves cell state, literal text and later-cell future imports without IPython', async () => {
    const result = await execute([
      'value = "обучение \\\\ literal"\nprint(value)',
      'from __future__ import annotations\ndef predict(value: MissingType):\n    return value * 2',
      'def another(value: AnotherMissingType):\n    return predict(value)\nassert another(21) == 42\nprint("MODEL_READY")',
    ]);
    assert.equal(result.status, 0, String(result.stderr));
    assert.match(String(result.stdout), /обучение \\ literal/);
    assert.match(String(result.stdout), /MODEL_READY/);
  });
  for (const isolated of [true, false]) it(`stops after a failed cell in ${isolated ? 'standard Python' : 'the selected environment'}`, async () => {
    const result = await execute(['print("started")', 'raise RuntimeError("training failed")', 'print("MUST_NOT_RUN")'], isolated);
    assert.notEqual(result.status, 0);
    assert.match(String(result.stdout) + String(result.stderr), /training failed/);
    assert.doesNotMatch(String(result.stdout), /MUST_NOT_RUN/);
  });
  it('runs notebook magics and shared cell state when the compute environment has IPython', async function () {
    if (spawnSync('python3', ['-c', 'import IPython'], { stdio: 'ignore' }).status !== 0) this.skip();
    const result = await execute(['%time value = 21', 'from __future__ import annotations',
      'def predict(value: MissingType):\n    return value * 2\nassert predict(value) == 42\nprint("MAGIC_MODEL_READY")'], false);
    assert.equal(result.status, 0, String(result.stderr));
    assert.match(String(result.stdout), /MAGIC_MODEL_READY/);
  });
});
