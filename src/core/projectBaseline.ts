import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { copyProject, scanDirectories, scanProject } from './projectFiles';

export interface ProjectManifestEntry {
  relativePath: string;
  kind: 'text' | 'notebook' | 'binary';
  size: number;
  hash: string;
}

export interface ProjectManifestV1 {
  version: 1;
  files: ProjectManifestEntry[];
  directories: string[];
}

export interface LaunchBaselineV1 {
  version: 1;
  working: ProjectManifestV1;
  source?: ProjectManifestV1 | undefined;
  sourceRealPath?: string | undefined;
  sourceDevice?: string | undefined;
  sourceInode?: string | undefined;
}

export type ProjectDriftClassification =
  | 'unchanged'
  | 'source-only'
  | 'working-only'
  | 'identical-change'
  | 'conflict';

export interface StableProjectCopyOptions {
  maxAttempts?: number | undefined;
  copy?: ((source: string, destination: string) => Promise<void>) | undefined;
}

export interface StableProjectCopyResult {
  baseline: LaunchBaselineV1;
  attempts: number;
}

export interface RefreshedProjectResult {
  manifest: ProjectManifestV1;
  attempts: number;
}

export async function captureProjectManifest(root: string): Promise<ProjectManifestV1> {
  const [files, directories] = await Promise.all([
    scanProject(root),
    scanDirectories(root),
  ]);
  return {
    version: 1,
    files: files
      .map(({ relativePath, kind, size, hash }) => ({ relativePath, kind, size, hash }))
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
    directories: [...directories].sort((left, right) => left.localeCompare(right)),
  };
}

export function projectManifestDigest(manifest: ProjectManifestV1): string {
  return createHash('sha256').update(JSON.stringify(manifest), 'utf8').digest('hex');
}

export function projectManifestsEqual(left: ProjectManifestV1, right: ProjectManifestV1): boolean {
  return projectManifestDigest(left) === projectManifestDigest(right);
}

export function classifyProjectDrift(
  baseline: ProjectManifestV1,
  working: ProjectManifestV1,
  source: ProjectManifestV1,
): ProjectDriftClassification {
  const workingMatchesBaseline = projectManifestsEqual(working, baseline);
  const sourceMatchesBaseline = projectManifestsEqual(source, baseline);
  if (workingMatchesBaseline && sourceMatchesBaseline) return 'unchanged';
  if (projectManifestsEqual(working, source)) return 'identical-change';
  if (workingMatchesBaseline) return 'source-only';
  if (sourceMatchesBaseline) return 'working-only';
  return 'conflict';
}

export async function stableCopyProject(
  source: string,
  destination: string,
  options: StableProjectCopyOptions = {},
): Promise<StableProjectCopyResult> {
  const sourceRealPath = await realpath(source);
  const sourceInfo = await stat(sourceRealPath);
  if (!sourceInfo.isDirectory()) throw new Error('The selected project source must be a directory.');
  await assertDestinationAbsent(destination);
  await mkdir(path.dirname(destination), { recursive: true });
  const maxAttempts = options.maxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new Error('Stable project copy attempts must be between 1 and 10.');
  }
  const copy = options.copy ?? copyProject;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const staging = path.join(
      path.dirname(destination),
      `.${path.basename(destination)}.pair-notebook-${randomUUID()}.tmp`,
    );
    try {
      const sourceBefore = await captureProjectManifest(sourceRealPath);
      await copy(sourceRealPath, staging);
      const [sourceAfter, working] = await Promise.all([
        captureProjectManifest(sourceRealPath),
        captureProjectManifest(staging),
      ]);
      if (!projectManifestsEqual(sourceBefore, sourceAfter)
        || !projectManifestsEqual(sourceAfter, working)) {
        if (attempt === maxAttempts) {
          throw new Error('The source project changed while Pair Notebook was creating its isolated copy.');
        }
        continue;
      }
      await rename(staging, destination);
      return {
        attempts: attempt,
        baseline: {
          version: 1,
          working,
          source: sourceAfter,
          sourceRealPath,
          sourceDevice: String(sourceInfo.dev),
          sourceInode: String(sourceInfo.ino),
        },
      };
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  throw new Error('The source project could not be copied consistently.');
}

export async function refreshWorkingCopyFromStableSource(
  source: string,
  destination: string,
  expectedCurrent: ProjectManifestV1,
  recoveryRoot: string,
): Promise<RefreshedProjectResult> {
  const before = await captureProjectManifest(destination);
  if (!projectManifestsEqual(before, expectedCurrent)) {
    throw new Error('The isolated working copy changed before source refresh could begin.');
  }
  const staging = path.join(path.dirname(destination), `.source-refresh-${randomUUID()}`);
  const recovery = path.join(recoveryRoot, `pre-refresh-${randomUUID()}`);
  let recoveryCreated = false;
  try {
    const stable = await stableCopyProject(source, staging);
    const immediatelyBefore = await captureProjectManifest(destination);
    if (!projectManifestsEqual(immediatelyBefore, expectedCurrent)) {
      throw new Error('The isolated working copy changed while the source refresh was being prepared.');
    }
    await copyProject(destination, recovery);
    recoveryCreated = true;
    const wanted = new Set(stable.baseline.working.files.map((file) => file.relativePath));
    for (const file of await scanProject(destination)) {
      if (!wanted.has(file.relativePath)) await rm(file.absolutePath, { force: true });
    }
    await copyProject(staging, destination);
    const refreshed = await captureProjectManifest(destination);
    if (!projectManifestsEqual(refreshed, stable.baseline.working)) {
      throw new Error(`Source refresh did not converge; the pre-refresh copy is preserved at ${recovery}.`);
    }
    await rm(recovery, { recursive: true, force: true });
    recoveryCreated = false;
    return { manifest: refreshed, attempts: stable.attempts };
  } catch (error) {
    if (recoveryCreated) {
      throw new Error(`Source refresh stopped safely; the pre-refresh copy is preserved at ${recovery}.`, { cause: error });
    }
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    if (!recoveryCreated) await rm(recovery, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function assertDestinationAbsent(destination: string): Promise<void> {
  try {
    await lstat(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error('The isolated working-copy destination already exists.');
}
