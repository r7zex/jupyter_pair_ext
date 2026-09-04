import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('terminal lifecycle product wiring', () => {
  it('uses the typed terminal event as the extension UI cleanup source', () => {
    const source = readFileSync(path.join(process.cwd(), 'src/extension.ts'), 'utf8');
    assert.match(source, /runtime\.on\('terminal', \(event: SessionTerminalLifecycle\)/);
    assert.doesNotMatch(source, /runtime\.on\('closed',/);
    assert.doesNotMatch(source, /sessionEnded[^\n]+host-lost/);
  });

  it('disables Run Cell and Restart when execution context is not available', () => {
    const manifest = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as any;
    const commands = new Map<string, { enablement?: string }>(
      manifest.contributes.commands.map((entry: { command: string; enablement?: string }) => [entry.command, entry]),
    );
    assert.equal(
      commands.get('pairNotebook.runActiveCell')?.enablement,
      'pairNotebook.inSession && pairNotebook.executionAvailable',
    );
    assert.equal(
      commands.get('pairNotebook.restartKernel')?.enablement,
      'pairNotebook.inSession && pairNotebook.executionAvailable',
    );
    assert.equal(
      manifest.contributes.menus['notebook/cell/title'][0].when,
      'pairNotebook.inSession && pairNotebook.executionAvailable',
    );
  });
});
