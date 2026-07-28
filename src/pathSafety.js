import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

function pathApiFor(filePath) {
  return /^(?:[A-Za-z]:[\\/]|\\\\)/.test(filePath) ? path.win32 : path;
}

function pathKind(stat) {
  if (stat.isDirectory()) return 'directory';
  if (stat.isFile()) return 'file';
  return 'other';
}

function sameIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.kind === right.kind
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.sha256 === right.sha256;
}

function statIdentity(stat) {
  return {
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    kind: pathKind(stat),
  };
}

function fileVersion(filePath, expectedStat, label) {
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    const before = fs.fstatSync(descriptor, { bigint: true });
    const expectedIdentity = statIdentity(expectedStat);
    if (!before.isFile() || !sameIdentity(statIdentity(before), expectedIdentity)) {
      throw new Error(`${label} changed while it was inspected; refusing to continue.`);
    }
    if (before.nlink !== 1n) {
      throw new Error(`${label} must not be a hard-linked file.`);
    }

    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (true) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }

    const after = fs.fstatSync(descriptor, { bigint: true });
    if (
      !sameIdentity(statIdentity(after), expectedIdentity)
      || after.nlink !== 1n
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs
    ) {
      throw new Error(`${label} changed while it was inspected; refusing to continue.`);
    }
    return {
      nlink: after.nlink.toString(),
      size: after.size.toString(),
      mtimeNs: after.mtimeNs.toString(),
      ctimeNs: after.ctimeNs.toString(),
      atimeNs: after.atimeNs.toString(),
      mode: Number(after.mode & 0o7777n),
      uid: after.uid.toString(),
      gid: after.gid.toString(),
      sha256: hash.digest('hex'),
    };
  } catch (error) {
    if (error && typeof error === 'object' && ['ELOOP', 'EMLINK'].includes(error.code)) {
      throw new Error(`${label} must not contain symbolic links.`);
    }
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function assertSafePath(
  filePath,
  safetyRoot,
  label = 'Installer path',
  expectedState,
  { allowMissingChange = false, allowTargetChange = false } = {},
) {
  const pathApi = pathApiFor(filePath);
  const resolvedFile = pathApi.resolve(filePath);
  const resolvedRoot = pathApi.resolve(safetyRoot);
  const relative = pathApi.relative(resolvedRoot, resolvedFile);
  if (relative === '..' || relative.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(relative)) {
    throw new Error(`${label} must remain within its expected configuration root.`);
  }

  const candidates = [resolvedRoot];
  let current = resolvedRoot;
  for (const part of relative.split(pathApi.sep).filter(Boolean)) {
    current = pathApi.join(current, part);
    candidates.push(current);
  }
  const components = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    try {
      const stat = fs.lstatSync(candidate, { bigint: true });
      if (stat.isSymbolicLink()) {
        throw new Error(`${label} must not contain symbolic links.`);
      }
      if (index < candidates.length - 1 && !stat.isDirectory()) {
        throw new Error(`${label} must contain only directory parents.`);
      }
      const component = {
        path: candidate,
        ...statIdentity(stat),
      };
      if (index === candidates.length - 1 && stat.isFile()) {
        Object.assign(component, fileVersion(candidate, stat, label));
      }
      components.push(component);
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') break;
      throw error;
    }
  }

  if (expectedState) {
    const currentByPath = new Map(components.map(component => [component.path, component]));
    for (const expected of expectedState.components) {
      if (allowTargetChange && expected.path === resolvedFile) continue;
      const currentComponent = currentByPath.get(expected.path);
      if (!currentComponent || !sameIdentity(currentComponent, expected)) {
        throw new Error(`${label} changed after it was inspected; refusing to continue.`);
      }
    }
    const missingPathChanged = expectedState.firstMissing
      && currentByPath.has(expectedState.firstMissing)
      && !allowMissingChange
      && !(allowTargetChange && expectedState.firstMissing === resolvedFile);
    if (missingPathChanged) {
      throw new Error(`${label} changed after it was inspected; refusing to continue.`);
    }
  }

  return {
    components,
    firstMissing: candidates[components.length],
  };
}
