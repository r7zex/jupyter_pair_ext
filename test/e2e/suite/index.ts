import path from 'node:path';
import Mocha from 'mocha';

export function run(): Promise<void> {
  const mocha = new Mocha({
    ui: 'tdd',
    color: true,
    timeout: 15_000,
    slow: 2_000,
  });
  // Controller/notebook suites intentionally run before extension activation so
  // they can instantiate the production controller id without colliding with
  // the singleton registered by activate(). Keep this order identical across
  // the Windows, Linux, macOS, and minimum-VS-Code matrix jobs.
  mocha.addFile(path.resolve(__dirname, '..', 'controllerHost.e2e.js'));
  mocha.addFile(path.resolve(__dirname, '..', 'notebookHost.e2e.js'));
  mocha.addFile(path.resolve(__dirname, '..', 'extensionHost.e2e.js'));

  return new Promise((resolve, reject) => {
    try {
      mocha.run((failures) => {
        if (failures > 0) reject(new Error(`${failures} VS Code Extension Host E2E test(s) failed.`));
        else resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
}
