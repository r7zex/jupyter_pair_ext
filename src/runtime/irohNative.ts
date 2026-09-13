import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

export type IrohModule = typeof import('@number0/iroh/index');

export function loadIroh(): IrohModule {
  const platform = process.platform;
  const arch = process.arch;
  const report = platform === 'linux' ? process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } : undefined;
  const suffix = platform === 'win32' ? 'msvc' : platform === 'linux'
    ? report?.header?.glibcVersionRuntime ? 'gnu' : 'musl' : undefined;
  const target = [platform, arch, suffix].filter(Boolean).join('-');
  const filename = `iroh.${target}.node`;
  const runtimeRequire = createRequire(__filename);
  const development = path.basename(__dirname) === 'runtime' && path.basename(path.dirname(__dirname)) === 'src';
  const root = path.resolve(__dirname, development ? '../../..' : '..');
  const binary = path.join(root, 'media', 'native', filename);
  if (existsSync(binary)) return runtimeRequire(binary) as IrohModule;
  // Development/test checkout only. Packaged releases must contain the binary.
  if (development && existsSync(path.join(root, 'package.json'))) {
    return runtimeRequire('@number0/iroh/index.js') as IrohModule;
  }
  throw new Error(`The bundled Iroh transport is unavailable for ${target}.`);
}
