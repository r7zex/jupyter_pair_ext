import path from 'node:path';
import Mocha from 'mocha';

export function run(): Promise<void> {
  const mocha = new Mocha({
    ui: 'tdd',
    color: true,
    timeout: 15_000,
    slow: 2_000,
  });
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
