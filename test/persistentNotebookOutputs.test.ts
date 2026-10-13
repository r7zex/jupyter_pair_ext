import assert from 'node:assert/strict';
import { persistentNotebookOutputs } from '../src/vps/persistentNotebookOutputs';

const output = (messageType: string, content: Record<string, unknown>): Record<string, unknown> => ({ type: 'iopub', messageType, content });
describe('Persistent saved Jupyter outputs', () => {
  it('coalesces adjacent streams while preserving channel boundaries and execution count', () => {
    assert.deepEqual(persistentNotebookOutputs([
      output('stream', { name: 'stdout', text: 'one' }), output('stream', { name: 'stdout', text: [' two', '\n'] }),
      output('stream', { name: 'stderr', text: 'warning\n' }), output('stream', { name: 'stdout', text: 'three' }),
      { type: 'complete', executionCount: 4 },
    ]), { outputs: [{ output_type: 'stream', name: 'stdout', text: 'one two\n' },
      { output_type: 'stream', name: 'stderr', text: 'warning\n' }, { output_type: 'stream', name: 'stdout', text: 'three' }], executionCount: 4 });
  });

  it('updates all outputs for a display ID, preserves result counts and strips transient fields', () => {
    const events = [
      output('display_data', { data: { 'text/html': 'before' }, metadata: {}, transient: { display_id: 'figure' }, extra: 'transport' }),
      output('execute_result', { data: { 'text/plain': 'before' }, metadata: {}, execution_count: 2, transient: { display_id: 'figure' } }),
      output('display_data', { data: { 'text/plain': 'other' }, metadata: {}, transient: { display_id: 'other' } }),
      output('update_display_data', { data: { 'image/png': 'aW1hZ2U=' }, metadata: { width: 20 }, transient: { display_id: 'figure' } }),
      output('update_display_data', { data: { 'text/plain': 'unknown' }, metadata: {}, transient: { display_id: 'unknown' } }),
    ];
    const before = JSON.stringify(events);
    assert.deepEqual(persistentNotebookOutputs(events), { outputs: [
      { output_type: 'display_data', data: { 'image/png': 'aW1hZ2U=' }, metadata: { width: 20 } },
      { output_type: 'execute_result', data: { 'image/png': 'aW1hZ2U=' }, metadata: { width: 20 }, execution_count: 2 },
      { output_type: 'display_data', data: { 'text/plain': 'other' }, metadata: {} },
    ], executionCount: 2 });
    assert.equal(JSON.stringify(events), before);
  });

  it('keeps deferred output visible until a replacement arrives and retires cleared display IDs', () => {
    const initial = [output('display_data', { data: { 'text/plain': 'before' }, transient: { display_id: 'figure' } }),
      output('clear_output', { wait: true }), output('update_display_data', { data: { 'text/plain': 'updated' }, transient: { display_id: 'figure' } })];
    assert.deepEqual(persistentNotebookOutputs(initial).outputs, [{ output_type: 'display_data', data: { 'text/plain': 'updated' }, metadata: {} }]);
    assert.deepEqual(persistentNotebookOutputs([...initial, output('stream', { name: 'stdout', text: 'replacement' }),
      output('update_display_data', { data: { 'text/plain': 'stale' }, transient: { display_id: 'figure' } })]).outputs,
    [{ output_type: 'stream', name: 'stdout', text: 'replacement' }]);
    assert.deepEqual(persistentNotebookOutputs([...initial, output('clear_output', { wait: false })]).outputs, []);
  });

  it('persists schema-valid errors and visible channel or output truncation diagnostics', () => {
    assert.deepEqual(persistentNotebookOutputs([
      output('error', { ename: 'ValueError', evalue: 'bad', traceback: ['trace', 42], transient: 'discard' }),
      { type: 'channelError', channel: 'output', message: 'Kernel output exceeded the transport limit and was omitted.' },
      { type: 'channelError', channel: 'files', message: 'A returned file was omitted.\n' },
      { type: 'complete', executionCount: null },
    ]), { outputs: [{ output_type: 'error', ename: 'ValueError', evalue: 'bad', traceback: ['trace'] },
      { output_type: 'stream', name: 'stderr', text: 'Pair Notebook: Kernel output exceeded the transport limit and was omitted.\nPair Notebook: A returned file was omitted.\n' }], executionCount: null });
  });

  it('ignores unrelated or malformed stream events and normalizes result fields and invalid counts', () => {
    assert.deepEqual(persistentNotebookOutputs([
      { type: 'status', content: 'busy' }, output('stream', { name: 'other', text: 'ignore' }), output('stream', { name: 'stdout', text: [1] }),
      output('execute_result', { data: [], metadata: null, execution_count: -1, extra: true }),
      { type: 'complete', executionCount: -3 }, { type: 'complete', executionCount: 1.5 },
    ]), { outputs: [{ output_type: 'execute_result', data: {}, metadata: {}, execution_count: null }], executionCount: null });
  });
});
