import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { assertSafePath } from './pathSafety.js';

const DIRECTORY_FLAGS = fs.constants.O_RDONLY
  | (fs.constants.O_DIRECTORY || 0)
  | (fs.constants.O_NOFOLLOW || 0);
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const JOURNAL_MARKER = '@spala-ai/mcp-install-safe-write';
const JOURNAL_VERSION = 2;
const JOURNAL_LIMIT = 16 * 1024;
const STALE_LOCK_MS = 5 * 60 * 1000;
const MAX_LOCK_AGE_MS = 15 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 60 * 1000;
const PROCESS_NONCE = randomBytes(16).toString('hex');
const ACTIVE_LOCKS = new Map();

function linuxProcessStartIdentity(pid) {
  if (process.platform !== 'linux') return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    if (close < 0) return null;
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    const startTicks = fields[19];
    if (!/^\d+$/.test(startTicks || '')) return null;
    const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    if (!/^[a-f0-9-]{16,64}$/i.test(bootId)) return null;
    return `linux:${bootId}:${startTicks}`;
  } catch {
    return null;
  }
}

function processStartIdentity(pid) {
  return linuxProcessStartIdentity(pid);
}

const PROCESS_START_IDENTITY = processStartIdentity(process.pid);

function pathKind(stat) {
  if (stat.isDirectory()) return 'directory';
  if (stat.isFile()) return 'file';
  return 'other';
}

function identity(stat) {
  return {
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    kind: pathKind(stat),
  };
}

function identitiesMatch(left, right) {
  return Boolean(left && right)
    && left.dev === right.dev
    && left.ino === right.ino
    && left.kind === right.kind;
}

function changedError(label) {
  return new Error(`${label} changed after it was inspected; refusing to continue.`);
}

function hardLinkError(label) {
  return new Error(`${label} must not be a hard-linked file.`);
}

function operationHook(hook, stage, transaction) {
  if (!hook) return;
  hook(stage, {
    action: transaction.action,
    backupPath: transaction.backupPath,
    client: transaction.client,
    component: transaction.component,
    journalPath: transaction.journalPath,
    lockPath: transaction.lockPath,
    path: transaction.path,
  });
}

function readAll(fd, limit = Number.POSITIVE_INFINITY) {
  const chunks = [];
  let position = 0;
  while (true) {
    const remaining = Math.min(64 * 1024, limit - position);
    if (remaining <= 0) throw new Error('Installer transaction metadata is too large.');
    const chunk = Buffer.allocUnsafe(remaining);
    const count = fs.readSync(fd, chunk, 0, chunk.length, position);
    if (!count) break;
    chunks.push(chunk.subarray(0, count));
    position += count;
  }
  return Buffer.concat(chunks);
}

function writeAll(fd, content) {
  let offset = 0;
  while (offset < content.length) {
    offset += fs.writeSync(fd, content, offset, content.length - offset, offset);
  }
}

function hashBuffer(content) {
  return createHash('sha256').update(content).digest('hex');
}

function lstatOrUndefined(filePath) {
  try {
    return fs.lstatSync(filePath, { bigint: true });
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function assertSingleLinkFile(stat, label) {
  if (!stat.isFile()) throw changedError(label);
  if (stat.nlink !== 1n) throw hardLinkError(label);
}

function fileMetadata(stat) {
  return {
    mode: Number(stat.mode & 0o7777n),
    uid: stat.uid.toString(),
    gid: stat.gid.toString(),
    atimeNs: stat.atimeNs.toString(),
    mtimeNs: stat.mtimeNs.toString(),
  };
}

function metadataMatches(stat, metadata) {
  return Number(stat.mode & 0o7777n) === metadata.mode
    && stat.uid.toString() === metadata.uid
    && stat.gid.toString() === metadata.gid;
}

function applyOwnershipAndMode(fd, metadata) {
  const current = fs.fstatSync(fd, { bigint: true });
  if (current.uid.toString() !== metadata.uid || current.gid.toString() !== metadata.gid) {
    fs.fchownSync(fd, Number(metadata.uid), Number(metadata.gid));
  }
  fs.fchmodSync(fd, metadata.mode);
}

function restoreMetadata(fd, metadata, { timestamps = true } = {}) {
  applyOwnershipAndMode(fd, metadata);
  if (timestamps) {
    fs.futimesSync(
      fd,
      Number(metadata.atimeNs) / 1_000_000_000,
      Number(metadata.mtimeNs) / 1_000_000_000,
    );
  }
  fs.fsyncSync(fd);
  const restored = fs.fstatSync(fd, { bigint: true });
  if (!metadataMatches(restored, metadata)) {
    throw new Error('Installer rollback could not restore file ownership and mode exactly.');
  }
}

function syncCurrentDirectory() {
  const fd = fs.openSync('.', DIRECTORY_FLAGS);
  try {
    fs.fsyncSync(fd);
  } catch (error) {
    const unsupported = error
      && typeof error === 'object'
      && ['EINVAL', 'ENOTSUP', 'EBADF'].includes(error.code);
    if (!unsupported) throw error;
  } finally {
    fs.closeSync(fd);
  }
}

function chdirToDescriptor(fd, fallbackPath, expectedIdentity, label) {
  const descriptorPath = process.platform === 'win32' ? undefined : `/dev/fd/${fd}`;
  if (descriptorPath) {
    try {
      process.chdir(descriptorPath);
      if (!identitiesMatch(identity(fs.statSync('.', { bigint: true })), expectedIdentity)) {
        throw changedError(label);
      }
      return;
    } catch (error) {
      const unsupported = error
        && typeof error === 'object'
        && ['ENOENT', 'ENOTDIR', 'EACCES', 'EINVAL'].includes(error.code);
      if (!unsupported) throw error;
    }
  }

  const named = lstatOrUndefined(fallbackPath);
  if (
    !named
    || named.isSymbolicLink()
    || !named.isDirectory()
    || !identitiesMatch(identity(named), expectedIdentity)
  ) {
    throw changedError(label);
  }
  process.chdir(fallbackPath);
  if (!identitiesMatch(identity(fs.statSync('.', { bigint: true })), expectedIdentity)) {
    throw changedError(label);
  }
}

function withAnchoredDirectory(directoryPath, expectedIdentity, label, callback) {
  const previousPath = process.cwd();
  const previousFd = fs.openSync('.', DIRECTORY_FLAGS);
  const previousIdentity = identity(fs.fstatSync(previousFd, { bigint: true }));
  const fd = fs.openSync(directoryPath, DIRECTORY_FLAGS);
  let changedDirectory = false;
  let restorationError;
  try {
    const fdIdentity = identity(fs.fstatSync(fd, { bigint: true }));
    if (fdIdentity.kind !== 'directory' || (expectedIdentity && !identitiesMatch(fdIdentity, expectedIdentity))) {
      throw changedError(label);
    }
    chdirToDescriptor(fd, directoryPath, fdIdentity, label);
    changedDirectory = true;
    return callback(fdIdentity);
  } finally {
    if (changedDirectory) {
      try {
        chdirToDescriptor(previousFd, previousPath, previousIdentity, 'Installer working directory');
      } catch (error) {
        restorationError = error;
      }
    }
    fs.closeSync(fd);
    fs.closeSync(previousFd);
    if (restorationError) throw restorationError;
  }
}

function verifyAnchoredParent(transaction) {
  if (!identitiesMatch(identity(fs.statSync('.', { bigint: true })), transaction.parentIdentity)) {
    throw changedError(transaction.pathLabel);
  }
}

function verifyAbsoluteParent(transaction, { ignorePlannedTarget = false } = {}) {
  const parentPath = path.dirname(transaction.path);
  const parentStat = lstatOrUndefined(parentPath);
  if (
    !parentStat
    || parentStat.isSymbolicLink()
    || !identitiesMatch(identity(parentStat), transaction.parentIdentity)
  ) {
    throw changedError(transaction.pathLabel);
  }
  verifyAnchoredParent(transaction);
  assertSafePath(
    transaction.path,
    transaction.safetyRoot,
    transaction.pathLabel,
    ignorePlannedTarget ? undefined : transaction.currentPathState,
    { allowTargetChange: transaction.targetMutated },
  );
}

function readNamedFile(name, label, expectedIdentity, limit) {
  const fd = fs.openSync(name, fs.constants.O_RDONLY | NOFOLLOW);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    assertSingleLinkFile(before, label);
    if (expectedIdentity && !identitiesMatch(identity(before), expectedIdentity)) throw changedError(label);
    const content = readAll(fd, limit);
    const after = fs.fstatSync(fd, { bigint: true });
    assertSingleLinkFile(after, label);
    if (!identitiesMatch(identity(before), identity(after))) throw changedError(label);
    const named = lstatOrUndefined(name);
    if (!named || named.isSymbolicLink() || !identitiesMatch(identity(named), identity(after))) {
      throw changedError(label);
    }
    return { content, fdIdentity: identity(after), metadata: fileMetadata(after), stat: after };
  } finally {
    fs.closeSync(fd);
  }
}

function readTarget(transaction, expectedIdentity, expectedContent) {
  const name = path.basename(transaction.path);
  const result = readNamedFile(name, transaction.pathLabel, expectedIdentity);
  if (expectedContent && !result.content.equals(expectedContent)) throw changedError(transaction.pathLabel);
  return result;
}

function openGuardedTarget(transaction, expectedIdentity, expectedContent) {
  const name = path.basename(transaction.path);
  const fd = fs.openSync(name, fs.constants.O_RDONLY | NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    assertSingleLinkFile(stat, transaction.pathLabel);
    if (!identitiesMatch(identity(stat), expectedIdentity)) throw changedError(transaction.pathLabel);
    const content = readAll(fd);
    if (!content.equals(expectedContent)) throw changedError(transaction.pathLabel);
    const named = lstatOrUndefined(name);
    if (!named || named.isSymbolicLink() || !identitiesMatch(identity(named), identity(stat))) {
      throw changedError(transaction.pathLabel);
    }
    return { fd, content, metadata: fileMetadata(stat) };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function readDetachedGuard(guard, expectedContent, label) {
  const before = fs.fstatSync(guard.fd, { bigint: true });
  if (!before.isFile() || before.nlink > 1n) throw changedError(label);
  const content = readAll(guard.fd);
  const after = fs.fstatSync(guard.fd, { bigint: true });
  if (
    !identitiesMatch(identity(before), identity(after))
    || before.size !== after.size
    || before.mtimeNs !== after.mtimeNs
    || before.ctimeNs !== after.ctimeNs
  ) {
    throw changedError(label);
  }
  return {
    changed: !content.equals(expectedContent),
    content,
    metadata: fileMetadata(after),
  };
}

function verifyTargetMissing(transaction) {
  const stat = lstatOrUndefined(path.basename(transaction.path));
  if (stat) throw changedError(transaction.pathLabel);
}

function recordArtifact(transaction, kind, name) {
  const artifact = {
    kind,
    name,
    path: path.join(path.dirname(transaction.path), name),
    owned: false,
    identity: undefined,
  };
  transaction.artifacts.push(artifact);
  return artifact;
}

function verifyArtifact(transaction, artifact) {
  if (!artifact.owned) return false;
  const stat = lstatOrUndefined(artifact.name);
  if (!stat || stat.isSymbolicLink()) throw changedError(`${transaction.pathLabel} ${artifact.kind}`);
  assertSingleLinkFile(stat, `${transaction.pathLabel} ${artifact.kind}`);
  if (!identitiesMatch(identity(stat), artifact.identity)) {
    throw changedError(`${transaction.pathLabel} ${artifact.kind}`);
  }
  return true;
}

function createArtifact(transaction, kind, name, content, hook, metadata) {
  const artifact = recordArtifact(transaction, kind, name);
  verifyAbsoluteParent(transaction, { ignorePlannedTarget: transaction.recovering });
  const fd = fs.openSync(
    name,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW,
    0o600,
  );
  artifact.owned = true;
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    assertSingleLinkFile(stat, `${transaction.pathLabel} ${kind}`);
    artifact.identity = identity(stat);
    operationHook(hook, `after_${kind}_opened`, transaction);
    writeAll(fd, content);
    if (metadata) applyOwnershipAndMode(fd, metadata);
    else fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  verifyArtifact(transaction, artifact);
  syncCurrentDirectory();
  operationHook(hook, `after_${kind}_created`, transaction);
  return artifact;
}

function publishedArtifact(transaction, kind, name) {
  const artifact = recordArtifact(transaction, kind, name);
  const stat = fs.lstatSync(name, { bigint: true });
  if (stat.isSymbolicLink()) throw changedError(`${transaction.pathLabel} ${kind}`);
  assertSingleLinkFile(stat, `${transaction.pathLabel} ${kind}`);
  artifact.owned = true;
  artifact.identity = identity(stat);
  return artifact;
}

function publishLockRecord(transaction, record, hook) {
  const next = createArtifact(
    transaction,
    'lock_next',
    record.lockNext,
    recordContent(record),
    hook,
  );
  operationHook(hook, 'before_lock_publish', transaction);
  verifyAnchoredParent(transaction);
  if (lstatOrUndefined(record.lock)) {
    const error = new Error(`${transaction.pathLabel} is locked by another installer operation.`);
    error.code = 'EEXIST';
    throw error;
  }
  fs.linkSync(next.name, record.lock);
  operationHook(hook, 'after_lock_link_before_temp_cleanup', transaction);
  const nextStat = fs.lstatSync(next.name, { bigint: true });
  const lockStat = fs.lstatSync(record.lock, { bigint: true });
  if (
    nextStat.isSymbolicLink()
    || lockStat.isSymbolicLink()
    || nextStat.nlink !== 2n
    || lockStat.nlink !== 2n
    || !identitiesMatch(identity(nextStat), identity(lockStat))
  ) {
    throw changedError(`${transaction.pathLabel} lock`);
  }
  fs.unlinkSync(next.name);
  next.owned = false;
  syncCurrentDirectory();
  const lock = publishedArtifact(transaction, 'lock', record.lock);
  operationHook(hook, 'after_lock_created', transaction);
  return lock;
}

function publishJournalRecord(transaction, record, hook, existingJournal) {
  const next = createArtifact(
    transaction,
    'journal_next',
    record.journalNext,
    recordContent(record),
    hook,
  );
  if (existingJournal) verifyArtifact(transaction, existingJournal);
  else if (lstatOrUndefined(record.journal)) throw changedError(`${transaction.pathLabel} journal`);
  verifyArtifact(transaction, next);
  operationHook(hook, 'before_journal_publish', transaction);
  fs.renameSync(next.name, record.journal);
  operationHook(hook, 'after_journal_rename_before_publish_state', transaction);
  next.owned = false;
  const journal = existingJournal || publishedArtifact(transaction, 'journal', record.journal);
  if (existingJournal) {
    journal.identity = identity(fs.lstatSync(journal.name, { bigint: true }));
  }
  syncCurrentDirectory();
  operationHook(hook, 'after_journal_created', transaction);
  return journal;
}

function removeArtifact(transaction, artifact, hook) {
  if (!artifact?.owned) return;
  operationHook(hook, 'before_artifact_unlink', transaction);
  verifyAnchoredParent(transaction);
  verifyArtifact(transaction, artifact);
  fs.unlinkSync(artifact.name);
  artifact.owned = false;
  syncCurrentDirectory();
}

function removeNamedOwnedArtifact(transaction, name, label) {
  if (!name) return;
  const stat = lstatOrUndefined(name);
  if (!stat) return;
  if (stat.isSymbolicLink()) throw changedError(label);
  assertSingleLinkFile(stat, label);
  fs.unlinkSync(name);
  syncCurrentDirectory();
}

function randomOperationId() {
  return `${process.pid}-${Date.now()}-${randomBytes(8).toString('hex')}`;
}

function transactionNames(transaction) {
  const target = path.basename(transaction.path);
  const id = randomOperationId();
  const backup = transaction.existed ? `${target}.bak-${id}` : null;
  return {
    id,
    target,
    lock: `${target}.spala-install.lock`,
    lockNext: `${target}.spala-install.lock-next-${id}`,
    journal: `${target}.spala-install.journal`,
    journalNext: `${target}.spala-install.journal-next-${id}`,
    temporary: transaction.removeFile ? null : `${target}.spala-install.tmp-${id}`,
    backup,
    backupMetadata: backup ? `${backup}.spala-meta.json` : null,
  };
}

function recordContent(record) {
  return Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
}

function makeRecord(transaction, names, original, originalMetadata, desired, desiredMetadata) {
  return {
    marker: JOURNAL_MARKER,
    version: JOURNAL_VERSION,
    operationId: names.id,
    phase: 'locked',
    action: transaction.removeFile ? 'remove' : transaction.existed ? 'update' : 'create',
    owner: {
      pid: process.pid,
      startIdentity: PROCESS_START_IDENTITY,
      nonce: PROCESS_NONCE,
    },
    createdAt: Date.now(),
    target: names.target,
    lock: names.lock,
    lockNext: names.lockNext,
    journal: names.journal,
    journalNext: names.journalNext,
    temporary: names.temporary,
    backup: names.backup,
    backupMetadata: names.backupMetadata,
    original: original ? {
      sha256: hashBuffer(original),
      size: original.length,
      metadata: originalMetadata,
    } : null,
    desired: desired ? {
      sha256: hashBuffer(desired),
      size: desired.length,
      metadata: desiredMetadata,
    } : null,
  };
}

function validArtifactName(name, target, kind) {
  if (name === null && ['temporary', 'backup', 'backupMetadata'].includes(kind)) return true;
  if (typeof name !== 'string' || !name || path.basename(name) !== name) return false;
  const prefixes = {
    lock: `${target}.spala-install.lock`,
    lockNext: `${target}.spala-install.lock-next-`,
    journal: `${target}.spala-install.journal`,
    journalNext: `${target}.spala-install.journal-next-`,
    temporary: `${target}.spala-install.tmp-`,
    backup: `${target}.bak-`,
    backupMetadata: `${target}.bak-`,
  };
  if (kind === 'lock' || kind === 'journal') return name === prefixes[kind];
  if (!name.startsWith(prefixes[kind])) return false;
  if (kind === 'backupMetadata' && !name.endsWith('.spala-meta.json')) return false;
  return !/[/\\\0]/.test(name);
}

function validMetadata(value) {
  return Boolean(value)
    && Object.keys(value).length === 5
    && ['mode', 'uid', 'gid', 'atimeNs', 'mtimeNs'].every(key => Object.hasOwn(value, key))
    && Number.isInteger(value.mode)
    && value.mode >= 0
    && value.mode <= 0o7777
    && ['uid', 'gid', 'atimeNs', 'mtimeNs'].every(key => /^\d+$/.test(value[key]));
}

function validDigest(value) {
  return Boolean(value)
    && Object.keys(value).length === 3
    && ['size', 'sha256', 'metadata'].every(key => Object.hasOwn(value, key))
    && Number.isSafeInteger(value.size)
    && value.size >= 0
    && /^[a-f0-9]{64}$/.test(value.sha256)
    && validMetadata(value.metadata);
}

function validateRecord(value, target) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const recordKeys = [
    'marker',
    'version',
    'operationId',
    'phase',
    'action',
    'owner',
    'createdAt',
    'target',
    'lock',
    'lockNext',
    'journal',
    'journalNext',
    'temporary',
    'backup',
    'backupMetadata',
    'original',
    'desired',
  ];
  if (
    Object.keys(value).length !== recordKeys.length
    || recordKeys.some(key => !Object.hasOwn(value, key))
    || value.marker !== JOURNAL_MARKER
    || value.version !== JOURNAL_VERSION
    || !/^[1-9]\d*-\d{13}-[a-f0-9]{16}$/.test(value.operationId || '')
    || !['locked', 'prepared', 'committed'].includes(value.phase)
    || !['create', 'update', 'remove'].includes(value.action)
    || !value.owner
    || typeof value.owner !== 'object'
    || Array.isArray(value.owner)
    || Object.keys(value.owner).length !== 3
    || !['pid', 'startIdentity', 'nonce'].every(key => Object.hasOwn(value.owner, key))
    || !Number.isSafeInteger(value.owner.pid)
    || value.owner.pid <= 0
    || (value.owner.startIdentity !== null && !/^linux:[a-f0-9-]{16,64}:\d+$/i.test(value.owner.startIdentity || ''))
    || !/^[a-f0-9]{32}$/.test(value.owner.nonce || '')
    || !Number.isSafeInteger(value.createdAt)
    || value.createdAt <= 0
    || value.target !== target
  ) {
    return false;
  }
  for (const kind of ['lock', 'lockNext', 'journal', 'journalNext', 'temporary', 'backup', 'backupMetadata']) {
    if (!validArtifactName(value[kind], target, kind)) return false;
  }
  const expectedNames = {
    lock: `${target}.spala-install.lock`,
    lockNext: `${target}.spala-install.lock-next-${value.operationId}`,
    journal: `${target}.spala-install.journal`,
    journalNext: `${target}.spala-install.journal-next-${value.operationId}`,
    temporary: `${target}.spala-install.tmp-${value.operationId}`,
    backup: `${target}.bak-${value.operationId}`,
    backupMetadata: `${target}.bak-${value.operationId}.spala-meta.json`,
  };
  if (
    value.lock !== expectedNames.lock
    || value.lockNext !== expectedNames.lockNext
    || value.journal !== expectedNames.journal
    || value.journalNext !== expectedNames.journalNext
    || (value.temporary !== null && value.temporary !== expectedNames.temporary)
    || (value.backup !== null && value.backup !== expectedNames.backup)
    || (value.backupMetadata !== null && value.backupMetadata !== expectedNames.backupMetadata)
  ) return false;
  if (value.action === 'create') {
    if (value.original !== null || value.backup !== null || value.backupMetadata !== null || !validDigest(value.desired)) return false;
  } else if (value.action === 'remove') {
    if (!validDigest(value.original) || value.desired !== null || value.temporary !== null) return false;
  } else if (!validDigest(value.original) || !validDigest(value.desired)) {
    return false;
  }
  return value;
}

function readTransactionRecord(name, target, label) {
  const stat = lstatOrUndefined(name);
  if (!stat) return undefined;
  if (stat.isSymbolicLink()) throw changedError(label);
  assertSingleLinkFile(stat, label);
  let parsed;
  try {
    parsed = JSON.parse(readNamedFile(name, label, identity(stat), JOURNAL_LIMIT).content.toString('utf8'));
  } catch {
    throw new Error(`${label} is not recognized installer transaction metadata; refusing recovery.`);
  }
  const record = validateRecord(parsed, target);
  if (!record) throw new Error(`${label} is not recognized installer transaction metadata; refusing recovery.`);
  return record;
}

function readLockCandidate(name, target) {
  const stat = lstatOrUndefined(name);
  if (!stat || stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 2n) return undefined;
  let fd;
  try {
    fd = fs.openSync(name, fs.constants.O_RDONLY | NOFOLLOW);
    const before = fs.fstatSync(fd, { bigint: true });
    if (
      !before.isFile()
      || before.nlink < 1n
      || before.nlink > 2n
      || !identitiesMatch(identity(before), identity(stat))
    ) return undefined;
    const content = readAll(fd, JOURNAL_LIMIT);
    const after = fs.fstatSync(fd, { bigint: true });
    const named = lstatOrUndefined(name);
    if (
      !named
      || named.isSymbolicLink()
      || !identitiesMatch(identity(before), identity(after))
      || !identitiesMatch(identity(after), identity(named))
    ) return undefined;
    const parsed = JSON.parse(content.toString('utf8'));
    return validateRecord(parsed, target) || undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function reconcileLockPublication(transaction, target, lockName, lockPath) {
  const prefix = `${target}.spala-install.lock-next-`;
  const candidates = fs.readdirSync('.')
    .filter(name => name.startsWith(prefix))
    .slice(0, 64);
  for (const name of candidates) {
    const record = readLockCandidate(name, target);
    if (!record || record.lockNext !== name) continue;
    const candidateStat = lstatOrUndefined(name);
    const lockStat = lstatOrUndefined(lockName);
    const linkedPublication = Boolean(
      candidateStat
      && lockStat
      && !candidateStat.isSymbolicLink()
      && !lockStat.isSymbolicLink()
      && identitiesMatch(identity(candidateStat), identity(lockStat)),
    );
    if (lockStat && !linkedPublication) continue;
    if (!recordCanBeRecovered(record, lockPath)) {
      throw new Error(`${transaction.pathLabel} is locked by another installer operation.`);
    }
    if (linkedPublication) {
      if (candidateStat.nlink !== 2n || lockStat.nlink !== 2n) {
        throw changedError(`${transaction.pathLabel} lock`);
      }
    } else {
      assertSingleLinkFile(candidateStat, `${transaction.pathLabel} lock publication candidate`);
    }
    fs.unlinkSync(name);
    syncCurrentDirectory();
  }
}

function processIsAlive(pid) {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === 'object' && error.code === 'EPERM');
  }
}

function ownerStillMatches(record) {
  if (!processIsAlive(record.owner.pid)) return false;
  if (record.owner.startIdentity === null) return true;
  const currentIdentity = processStartIdentity(record.owner.pid);
  return currentIdentity === record.owner.startIdentity;
}

function recordCanBeRecovered(record, lockPath) {
  const age = Date.now() - record.createdAt;
  if (age < -MAX_CLOCK_SKEW_MS) return false;
  if (age >= MAX_LOCK_AGE_MS) return true;
  if (
    record.owner.pid === process.pid
    && record.owner.startIdentity === PROCESS_START_IDENTITY
    && record.owner.nonce === PROCESS_NONCE
  ) {
    return ACTIVE_LOCKS.get(lockPath) !== record.operationId;
  }
  return !ownerStillMatches(record) && age >= 0;
}

function inspectCurrentTarget(transaction) {
  const name = path.basename(transaction.path);
  const stat = lstatOrUndefined(name);
  if (!stat) return { exists: false };
  if (stat.isSymbolicLink()) throw changedError(transaction.pathLabel);
  assertSingleLinkFile(stat, transaction.pathLabel);
  const file = readNamedFile(name, transaction.pathLabel, identity(stat));
  return {
    exists: true,
    sha256: hashBuffer(file.content),
    size: file.content.length,
    metadata: file.metadata,
  };
}

function digestMatches(file, digest) {
  return Boolean(file.exists && digest)
    && file.sha256 === digest.sha256
    && file.size === digest.size
    && file.metadata.mode === digest.metadata.mode
    && file.metadata.uid === digest.metadata.uid
    && file.metadata.gid === digest.metadata.gid;
}

function verifyBackupForRecord(transaction, record) {
  if (!record.backup || !record.original) return;
  const backupStat = lstatOrUndefined(record.backup);
  const metadataStat = lstatOrUndefined(record.backupMetadata);
  if (!backupStat || !metadataStat || backupStat.isSymbolicLink() || metadataStat.isSymbolicLink()) {
    throw changedError(`${transaction.pathLabel} recovery backup`);
  }
  assertSingleLinkFile(backupStat, `${transaction.pathLabel} recovery backup`);
  assertSingleLinkFile(metadataStat, `${transaction.pathLabel} recovery metadata`);
  const backup = readNamedFile(
    record.backup,
    `${transaction.pathLabel} recovery backup`,
    identity(backupStat),
  );
  if (backup.content.length !== record.original.size || hashBuffer(backup.content) !== record.original.sha256) {
    throw changedError(`${transaction.pathLabel} recovery backup`);
  }
  let metadata;
  try {
    metadata = JSON.parse(readNamedFile(
      record.backupMetadata,
      `${transaction.pathLabel} recovery metadata`,
      identity(metadataStat),
      JOURNAL_LIMIT,
    ).content.toString('utf8'));
  } catch {
    throw changedError(`${transaction.pathLabel} recovery metadata`);
  }
  if (
    metadata?.marker !== JOURNAL_MARKER
    || metadata?.version !== JOURNAL_VERSION
    || metadata?.target !== record.target
    || metadata?.backup !== record.backup
    || metadata?.sha256 !== record.original.sha256
    || JSON.stringify(metadata?.metadata) !== JSON.stringify(record.original.metadata)
  ) {
    throw changedError(`${transaction.pathLabel} recovery metadata`);
  }
}

function recoverWithinParent(transaction, hook) {
  const target = path.basename(transaction.path);
  const lockName = `${target}.spala-install.lock`;
  const journalName = `${target}.spala-install.journal`;
  const lockPath = path.join(path.dirname(transaction.path), lockName);
  reconcileLockPublication(transaction, target, lockName, lockPath);
  const lockRecord = readTransactionRecord(lockName, target, `${transaction.pathLabel} lock`);
  const journalRecord = readTransactionRecord(journalName, target, `${transaction.pathLabel} journal`);
  if (!lockRecord && !journalRecord) return false;
  const record = journalRecord || lockRecord;
  if (lockRecord && JSON.stringify({ ...lockRecord, phase: record.phase }) !== JSON.stringify(record)) {
    const comparableLock = { ...lockRecord, phase: record.phase };
    if (JSON.stringify(comparableLock) !== JSON.stringify(record)) {
      throw new Error(`${transaction.pathLabel} transaction metadata conflicts; refusing recovery.`);
    }
  }
  if (!recordCanBeRecovered(record, lockPath)) {
    const age = Date.now() - record.createdAt;
    const stale = age >= STALE_LOCK_MS ? 'active stale' : 'active';
    throw new Error(`${transaction.pathLabel} is locked by another ${stale} installer operation.`);
  }

  transaction.recovering = true;
  try {
    operationHook(hook, 'before_stale_recovery', transaction);
    verifyAbsoluteParent(transaction, { ignorePlannedTarget: true });
    const current = inspectCurrentTarget(transaction);
    const original = digestMatches(current, record.original);
    const desired = digestMatches(current, record.desired);
    const committed = record.action === 'remove' ? !current.exists : desired;
    const uncommitted = record.action === 'create' ? !current.exists : original;
    if (!committed && !uncommitted) {
      throw new Error(`${transaction.pathLabel} changed during an interrupted installer operation; refusing recovery.`);
    }
    if (committed && record.backup) verifyBackupForRecord(transaction, record);

    for (const name of [record.lockNext, record.temporary, record.journalNext]) {
      removeNamedOwnedArtifact(transaction, name, `${transaction.pathLabel} recovery artifact`);
    }
    if (uncommitted) {
      for (const name of [record.backupMetadata, record.backup]) {
        removeNamedOwnedArtifact(transaction, name, `${transaction.pathLabel} recovery artifact`);
      }
    }
    removeNamedOwnedArtifact(transaction, record.journal, `${transaction.pathLabel} journal`);
    removeNamedOwnedArtifact(transaction, record.lock, `${transaction.pathLabel} lock`);
    operationHook(hook, 'after_stale_recovery', transaction);
    return true;
  } finally {
    transaction.recovering = false;
  }
}

function createBackupMetadata(transaction, record, hook) {
  if (!record.backupMetadata) return undefined;
  const content = recordContent({
    marker: JOURNAL_MARKER,
    version: JOURNAL_VERSION,
    target: record.target,
    backup: record.backup,
    sha256: record.original.sha256,
    metadata: record.original.metadata,
  });
  return createArtifact(transaction, 'backup_metadata', record.backupMetadata, content, hook);
}

function updateJournalPhase(transaction, record, journal, hook, phase) {
  record.phase = phase;
  publishJournalRecord(transaction, record, hook, journal);
  operationHook(hook, `after_journal_${phase}`, transaction);
}

function atomicRestoreBuffer(transaction, content, metadata, hook, stage) {
  const name = `${path.basename(transaction.path)}.spala-install.restore-${randomOperationId()}`;
  const restore = createArtifact(transaction, 'restore', name, content, hook, metadata);
  const fd = fs.openSync(restore.name, fs.constants.O_RDONLY | NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    assertSingleLinkFile(stat, `${transaction.pathLabel} restore`);
    if (!identitiesMatch(identity(stat), restore.identity)) throw changedError(transaction.pathLabel);
    restoreMetadata(fd, metadata);
  } finally {
    fs.closeSync(fd);
  }
  operationHook(hook, stage, transaction);
  verifyAnchoredParent(transaction);
  fs.renameSync(restore.name, path.basename(transaction.path));
  restore.owned = false;
  syncCurrentDirectory();
}

function applyWithinParent(transaction, hook) {
  verifyAbsoluteParent(transaction);
  const originalExpected = transaction.existed
    ? Buffer.from(transaction.originalContent, 'utf8')
    : undefined;
  const desired = transaction.removeFile ? undefined : Buffer.from(transaction.content, 'utf8');
  let originalFile;
  if (transaction.existed) {
    originalFile = readTarget(transaction, transaction.originalTargetIdentity, originalExpected);
    transaction.originalMetadata = originalFile.metadata;
  } else {
    verifyTargetMissing(transaction);
  }

  const names = transactionNames(transaction);
  const parentStat = fs.statSync('.', { bigint: true });
  const desiredMetadata = transaction.existed
    ? transaction.originalMetadata
    : {
      mode: 0o600,
      uid: (typeof process.geteuid === 'function' ? process.geteuid() : Number(parentStat.uid)).toString(),
      gid: (typeof process.getegid === 'function' ? process.getegid() : Number(parentStat.gid)).toString(),
      atimeNs: '0',
      mtimeNs: '0',
    };
  const record = makeRecord(
    transaction,
    names,
    originalExpected,
    transaction.originalMetadata,
    desired,
    desiredMetadata,
  );
  transaction.lockPath = path.join(path.dirname(transaction.path), names.lock);
  transaction.journalPath = path.join(path.dirname(transaction.path), names.journal);

  if (ACTIVE_LOCKS.has(transaction.lockPath)) {
    throw new Error(`${transaction.pathLabel} is locked by another installer operation.`);
  }
  ACTIVE_LOCKS.set(transaction.lockPath, record.operationId);
  let lock;
  try {
    lock = publishLockRecord(transaction, record, hook);
  } catch (error) {
    ACTIVE_LOCKS.delete(transaction.lockPath);
    if (error && typeof error === 'object' && error.code === 'EEXIST') {
      throw new Error(`${transaction.pathLabel} is locked by another installer operation.`);
    }
    throw error;
  }

  let backup;
  if (record.backup) {
    transaction.backupPath = path.join(path.dirname(transaction.path), record.backup);
    transaction.backupMetadataPath = path.join(path.dirname(transaction.path), record.backupMetadata);
    backup = createArtifact(
      transaction,
      'backup',
      record.backup,
      originalExpected,
      hook,
    );
    createBackupMetadata(transaction, record, hook);
  }
  const temporary = record.temporary
    ? createArtifact(transaction, 'temporary', record.temporary, desired, hook, desiredMetadata)
    : undefined;
  record.phase = 'prepared';
  const journal = publishJournalRecord(transaction, record, hook);
  operationHook(hook, 'after_journal_prepared', transaction);

  verifyAbsoluteParent(transaction);
  if (transaction.existed) {
    readTarget(transaction, transaction.originalTargetIdentity, originalExpected);
    if (backup) {
      const checked = readNamedFile(backup.name, `${transaction.pathLabel} backup`, backup.identity);
      if (!checked.content.equals(originalExpected)) throw changedError(`${transaction.pathLabel} backup`);
    }
  } else {
    verifyTargetMissing(transaction);
  }
  operationHook(hook, 'after_target_final_check_before_detach', transaction);
  operationHook(hook, 'after_target_final_check_before_replace', transaction);
  operationHook(hook, 'after_target_check_before_write', transaction);
  verifyAbsoluteParent(transaction);
  if (transaction.existed) readTarget(transaction, transaction.originalTargetIdentity, originalExpected);
  else verifyTargetMissing(transaction);

  const guardedTarget = transaction.existed
    ? openGuardedTarget(transaction, transaction.originalTargetIdentity, originalExpected)
    : undefined;
  try {
    if (guardedTarget) operationHook(hook, 'after_target_guard_opened_before_atomic_replace', transaction);
    if (transaction.removeFile) {
      operationHook(hook, 'after_target_detach_before_unlink', transaction);
      verifyAbsoluteParent(transaction);
      readTarget(transaction, transaction.originalTargetIdentity, originalExpected);
      fs.unlinkSync(path.basename(transaction.path));
    } else {
      verifyArtifact(transaction, temporary);
      fs.renameSync(temporary.name, path.basename(transaction.path));
      temporary.owned = false;
      transaction.appliedTargetIdentity = identity(fs.lstatSync(path.basename(transaction.path), { bigint: true }));
    }
    transaction.targetMutated = true;
    syncCurrentDirectory();

    if (guardedTarget) {
      const detached = readDetachedGuard(guardedTarget, originalExpected, transaction.pathLabel);
      if (detached.changed) {
        atomicRestoreBuffer(
          transaction,
          detached.content,
          detached.metadata,
          hook,
          'before_concurrent_target_restore',
        );
        transaction.targetMutated = false;
        throw changedError(transaction.pathLabel);
      }
    }
  } finally {
    if (guardedTarget) fs.closeSync(guardedTarget.fd);
  }
  operationHook(hook, 'after_atomic_replace_before_validation', transaction);
  operationHook(
    hook,
    transaction.existed ? 'after_target_write_before_validation' : 'after_target_create_before_validation',
    transaction,
  );

  verifyAbsoluteParent(transaction, { ignorePlannedTarget: true });
  if (transaction.removeFile) {
    verifyTargetMissing(transaction);
  } else {
    const applied = readTarget(transaction, transaction.appliedTargetIdentity, desired);
    if (!metadataMatches(applied.stat, desiredMetadata)) throw changedError(transaction.pathLabel);
  }

  updateJournalPhase(transaction, record, journal, hook, 'committed');
  operationHook(
    hook,
    transaction.existed ? 'after_target_write' : 'after_target_create',
    transaction,
  );
  operationHook(hook, 'before_journal_cleanup', transaction);
  removeArtifact(transaction, journal, hook);
  operationHook(hook, 'after_journal_cleanup', transaction);
  removeArtifact(transaction, lock, hook);
  ACTIVE_LOCKS.delete(transaction.lockPath);
  operationHook(hook, 'after_lock_cleanup', transaction);
  transaction.currentPathState = assertSafePath(
    transaction.path,
    transaction.safetyRoot,
    transaction.pathLabel,
  );
}

function cleanupTransientArtifacts(transaction) {
  const transientKinds = new Set([
    'lock',
    'lock_next',
    'journal',
    'journal_next',
    'temporary',
    'restore',
    'rollback_guard',
  ]);
  for (const artifact of [...transaction.artifacts].reverse()) {
    if (artifact.owned && transientKinds.has(artifact.kind)) removeArtifact(transaction, artifact);
  }
  if (transaction.lockPath) ACTIVE_LOCKS.delete(transaction.lockPath);
}

function backupArtifacts(transaction) {
  return {
    backup: transaction.artifacts.find(artifact => artifact.kind === 'backup' && artifact.owned),
    metadata: transaction.artifacts.find(artifact => artifact.kind === 'backup_metadata' && artifact.owned),
  };
}

function verifyRollbackBackup(transaction, backup, metadata) {
  if (!backup || !metadata) throw changedError(`${transaction.pathLabel} backup`);
  const expected = Buffer.from(transaction.originalContent, 'utf8');
  const checked = readNamedFile(backup.name, `${transaction.pathLabel} backup`, backup.identity);
  if (!checked.content.equals(expected)) throw changedError(`${transaction.pathLabel} backup`);
  const sidecar = readNamedFile(metadata.name, `${transaction.pathLabel} backup metadata`, metadata.identity, JOURNAL_LIMIT);
  let parsed;
  try {
    parsed = JSON.parse(sidecar.content.toString('utf8'));
  } catch {
    throw changedError(`${transaction.pathLabel} backup metadata`);
  }
  if (
    parsed?.marker !== JOURNAL_MARKER
    || parsed?.target !== path.basename(transaction.path)
    || parsed?.backup !== backup.name
    || parsed?.sha256 !== hashBuffer(expected)
    || !validMetadata(parsed?.metadata)
  ) {
    throw changedError(`${transaction.pathLabel} backup metadata`);
  }
  return { content: expected, metadata: parsed.metadata };
}

function rollbackWithinParent(transaction, hook) {
  const { backup, metadata } = backupArtifacts(transaction);
  if (!transaction.targetMutated) {
    for (const artifact of [...transaction.artifacts].reverse()) {
      if (artifact.owned) removeArtifact(transaction, artifact, hook);
    }
    return;
  }

  if (transaction.existed) {
    const original = verifyRollbackBackup(transaction, backup, metadata);
    if (transaction.removeFile) {
      verifyTargetMissing(transaction);
      atomicRestoreBuffer(
        transaction,
        original.content,
        original.metadata,
        hook,
        'after_target_restore_check_before_create',
      );
    } else {
      readTarget(
        transaction,
        transaction.appliedTargetIdentity,
        Buffer.from(transaction.content, 'utf8'),
      );
      operationHook(hook, 'after_target_restore_check_before_write', transaction);
      operationHook(hook, 'after_target_restore_final_check_before_detach', transaction);
      readTarget(
        transaction,
        transaction.appliedTargetIdentity,
        Buffer.from(transaction.content, 'utf8'),
      );
      atomicRestoreBuffer(
        transaction,
        original.content,
        original.metadata,
        hook,
        'before_target_restore',
      );
    }
    transaction.targetMutated = false;
    removeArtifact(transaction, metadata, hook);
    removeArtifact(transaction, backup, hook);
    operationHook(hook, 'after_target_restore', transaction);
  } else {
    readTarget(
      transaction,
      transaction.appliedTargetIdentity,
      Buffer.from(transaction.content, 'utf8'),
    );
    operationHook(hook, 'before_rollback_target_unlink', transaction);
    operationHook(hook, 'after_rollback_target_final_check_before_detach', transaction);
    readTarget(
      transaction,
      transaction.appliedTargetIdentity,
      Buffer.from(transaction.content, 'utf8'),
    );
    const guard = recordArtifact(
      transaction,
      'rollback_guard',
      `${path.basename(transaction.path)}.spala-install.rollback-${randomOperationId()}`,
    );
    fs.renameSync(path.basename(transaction.path), guard.name);
    guard.owned = true;
    guard.identity = identity(fs.lstatSync(guard.name, { bigint: true }));
    syncCurrentDirectory();
    operationHook(hook, 'after_rollback_target_detach_before_unlink', transaction);
    removeArtifact(transaction, guard, hook);
    transaction.targetMutated = false;
  }

  cleanupTransientArtifacts(transaction);
  transaction.currentPathState = assertSafePath(
    transaction.path,
    transaction.safetyRoot,
    transaction.pathLabel,
  );
}

function removeCreatedDirectory(transaction, directory, hook) {
  if (!directory.owned) return;
  withAnchoredDirectory(
    directory.parentPath,
    directory.parentIdentity,
    `${transaction.pathLabel} parent`,
    () => {
      operationHook(hook, 'before_created_directory_remove', transaction);
      const child = lstatOrUndefined(path.basename(directory.path));
      if (!child) {
        directory.owned = false;
        return;
      }
      if (child.isSymbolicLink() || !identitiesMatch(identity(child), directory.identity)) {
        throw changedError(`${transaction.pathLabel} parent`);
      }
      fs.rmdirSync(path.basename(directory.path));
      directory.owned = false;
      syncCurrentDirectory();
    },
  );
}

function prepareAndAnchorParent(transaction, callback, { create = true } = {}) {
  const parentPath = path.dirname(transaction.path);
  const existingParent = transaction.currentPathState?.components
    .find(component => component.path === parentPath);
  if (existingParent) {
    return withAnchoredDirectory(parentPath, existingParent, transaction.pathLabel, parentIdentity => {
      transaction.parentIdentity = parentIdentity;
      return callback();
    });
  }
  if (!create) return false;

  const anchor = [...transaction.currentPathState.components].reverse().find(component => (
    component.kind === 'directory'
    && (parentPath === component.path || parentPath.startsWith(`${component.path}${path.sep}`))
  ));
  if (!anchor) throw changedError(transaction.pathLabel);
  const segments = path.relative(anchor.path, parentPath).split(path.sep).filter(Boolean);
  return withAnchoredDirectory(anchor.path, anchor, transaction.pathLabel, () => {
    let currentPath = anchor.path;
    let currentIdentity = anchor;
    for (const segment of segments) {
      if (lstatOrUndefined(segment)) throw changedError(transaction.pathLabel);
      const directory = {
        path: path.join(currentPath, segment),
        parentPath: currentPath,
        parentIdentity: currentIdentity,
        owned: false,
        identity: undefined,
      };
      transaction.createdDirectories.push(directory);
      fs.mkdirSync(segment, { mode: 0o700 });
      directory.owned = true;
      const stat = fs.lstatSync(segment, { bigint: true });
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw changedError(transaction.pathLabel);
      directory.identity = identity(stat);
      syncCurrentDirectory();
      const fd = fs.openSync(segment, DIRECTORY_FLAGS);
      try {
        chdirToDescriptor(fd, directory.path, directory.identity, transaction.pathLabel);
      } finally {
        fs.closeSync(fd);
      }
      currentPath = directory.path;
      currentIdentity = directory.identity;
    }
    transaction.parentIdentity = currentIdentity;
    transaction.currentPathState = assertSafePath(
      transaction.path,
      transaction.safetyRoot,
      transaction.pathLabel,
      transaction.currentPathState,
      { allowMissingChange: true },
    );
    return callback();
  });
}

export function recoverSafeFileWrite(transaction, hook) {
  transaction.artifacts ||= [];
  transaction.createdDirectories ||= [];
  transaction.currentPathState ||= transaction.pathState;
  const parentPath = path.dirname(transaction.path);
  const parent = lstatOrUndefined(parentPath);
  if (!parent || parent.isSymbolicLink() || !parent.isDirectory()) return false;
  const expectedParent = transaction.currentPathState?.components
    .find(component => component.path === parentPath);
  if (!expectedParent || !identitiesMatch(identity(parent), expectedParent)) {
    throw changedError(transaction.pathLabel);
  }
  return prepareAndAnchorParent(
    transaction,
    () => recoverWithinParent(transaction, hook),
    { create: false },
  );
}

export function applySafeFileWrite(transaction, hook) {
  transaction.artifacts ||= [];
  transaction.createdDirectories ||= [];
  transaction.currentPathState ||= transaction.pathState;
  transaction.originalTargetIdentity ||= transaction.pathState?.components
    .find(component => component.path === transaction.path);
  prepareAndAnchorParent(transaction, () => {
    try {
      recoverWithinParent(transaction, hook);
      verifyAbsoluteParent(transaction);
      applyWithinParent(transaction, hook);
    } catch (error) {
      if (error && typeof error === 'object' && error.simulatedCrash) {
        if (transaction.lockPath) ACTIVE_LOCKS.delete(transaction.lockPath);
        throw error;
      }
      const rollbackErrors = [];
      try {
        rollbackWithinParent(transaction);
        transaction.parentRollbackComplete = true;
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
        try {
          cleanupTransientArtifacts(transaction);
        } catch (cleanupError) {
          rollbackErrors.push(cleanupError);
        }
      }
      if (rollbackErrors.length && error && typeof error === 'object') error.changed = true;
      throw error;
    } finally {
      if (transaction.lockPath) ACTIVE_LOCKS.delete(transaction.lockPath);
    }
  });
  return {
    backupPath: transaction.backupPath,
    pathState: transaction.currentPathState,
  };
}

export function rollbackSafeFileWrite(transaction, hook) {
  const errors = [];
  if (transaction.parentIdentity && !transaction.parentRollbackComplete) {
    try {
      withAnchoredDirectory(
        path.dirname(transaction.path),
        transaction.parentIdentity,
        transaction.pathLabel,
        () => {
          try {
            rollbackWithinParent(transaction, hook);
          } catch (error) {
            errors.push(error);
            try {
              cleanupTransientArtifacts(transaction);
            } catch (cleanupError) {
              errors.push(cleanupError);
            }
          }
        },
      );
    } catch (error) {
      errors.push(error);
    }
  }
  for (const directory of [...(transaction.createdDirectories || [])].reverse()) {
    try {
      removeCreatedDirectory(transaction, directory, hook);
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}
