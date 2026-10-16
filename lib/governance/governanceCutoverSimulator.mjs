import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { GovernanceRepository, validateGovernanceDocument } from './governanceRepository.mjs';

function simulationError(code, message, details = {}, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  error.details = details;
  return error;
}

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function within(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export class GovernanceCutoverSimulator {
  constructor({ workspaceRoot, planner, repositoryFactory = (options) => new GovernanceRepository(options), faultInjector = null } = {}) {
    if (!workspaceRoot || !path.isAbsolute(workspaceRoot)) throw simulationError('GOVERNANCE_SIMULATION_ROOT_REQUIRED', 'An absolute temporary workspaceRoot is required.');
    if (!planner || typeof planner.prevalidate !== 'function') throw simulationError('GOVERNANCE_MIGRATION_PLANNER_REQUIRED', 'An injected migration planner is required.');
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.planner = planner;
    this.repositoryFactory = repositoryFactory;
    this.faultInjector = faultInjector;
  }

  execute({ sourcePath, destinationPath, activeCycleEvidence = {}, writerSuspended = false } = {}) {
    if (writerSuspended !== true) throw simulationError('GOVERNANCE_WRITERS_NOT_SUSPENDED', 'Logical writer suspension must be asserted.');
    if (!path.isAbsolute(sourcePath) || !within(this.workspaceRoot, sourcePath) || !path.isAbsolute(destinationPath) || !within(this.workspaceRoot, destinationPath)) {
      throw simulationError('GOVERNANCE_SIMULATION_PATH_OUTSIDE_WORKSPACE', 'Source and destination must be distinct children of the temporary workspace.');
    }
    if (path.resolve(sourcePath) === path.resolve(destinationPath)) throw simulationError('GOVERNANCE_SIMULATION_SOURCE_DESTINATION_CONFLICT', 'Source cannot be overwritten.');
    const cutoverLock = `${destinationPath}.cutover.lock`;
    try { fs.mkdirSync(cutoverLock); }
    catch (error) {
      if (error.code === 'EEXIST') throw simulationError('GOVERNANCE_CUTOVER_BUSY', 'Cutover lock exists and is not released by TTL.');
      throw error;
    }
    let published = false;
    try {
      const backupPath = `${destinationPath}.legacy-backup.json`;
      if (fs.existsSync(destinationPath) || fs.existsSync(backupPath)) {
        throw simulationError('GOVERNANCE_CUTOVER_DESTINATION_EXISTS', 'Cutover destination or its backup already exists.');
      }
      const sourceBytes = fs.readFileSync(sourcePath);
      const sourceHash = sha256(sourceBytes);
      fs.copyFileSync(sourcePath, backupPath, fs.constants.COPYFILE_EXCL);
      const backupDescriptor = fs.openSync(backupPath, 'r+');
      try { fs.fsyncSync(backupDescriptor); } finally { fs.closeSync(backupDescriptor); }
      if (sha256(fs.readFileSync(backupPath)) !== sourceHash) throw simulationError('GOVERNANCE_BACKUP_HASH_MISMATCH', 'Backup hash differs from source.');
      this.faultInjector?.('afterBackup', { sourcePath, destinationPath, backupPath });
      const migration = this.planner.prevalidate({ sourcePath, activeCycleEvidence });
      if (migration.sourceHash !== sourceHash) throw simulationError('GOVERNANCE_SOURCE_CHANGED', 'Source changed while migration was being prepared.');
      this.faultInjector?.('beforePublish', { sourcePath, destinationPath, backupPath, migration });
      if (sha256(fs.readFileSync(sourcePath)) !== sourceHash) throw simulationError('GOVERNANCE_SOURCE_CHANGED', 'A writer changed the source during cutover.');
      const repository = this.repositoryFactory({ filePath: destinationPath });
      const initialized = repository.initialize(migration.candidate);
      published = true;
      this.faultInjector?.('afterPublish', { sourcePath, destinationPath, backupPath, migration, repository });
      const confirmed = repository.read();
      validateGovernanceDocument(confirmed.document);
      const destinationHash = sha256(fs.readFileSync(destinationPath));
      return {
        writerSuspended: true,
        sourcePath, destinationPath, backupPath,
        sourceHash, backupHash: sha256(fs.readFileSync(backupPath)), destinationHash,
        baselineRevision: initialized.revision,
        migrationReport: migration.report,
        repository,
      };
    } catch (error) {
      if (published) error.published = true;
      throw error;
    } finally {
      fs.rmSync(cutoverLock, { recursive: true, force: false });
    }
  }

  verify(manifest) {
    const sourceHash = sha256(fs.readFileSync(manifest.sourcePath));
    const backupHash = sha256(fs.readFileSync(manifest.backupPath));
    const destinationHash = sha256(fs.readFileSync(manifest.destinationPath));
    const repository = this.repositoryFactory({ filePath: manifest.destinationPath });
    const confirmed = repository.read();
    validateGovernanceDocument(confirmed.document);
    return {
      ok: sourceHash === manifest.sourceHash && backupHash === manifest.backupHash,
      sourceUnchanged: sourceHash === manifest.sourceHash,
      backupVerified: backupHash === manifest.sourceHash,
      destinationHash,
      revision: confirmed.revision,
    };
  }

  rollback(manifest) {
    const repository = this.repositoryFactory({ filePath: manifest.destinationPath });
    const current = repository.read();
    const currentHash = sha256(fs.readFileSync(manifest.destinationPath));
    if (current.revision !== manifest.baselineRevision || currentHash !== manifest.destinationHash) {
      throw simulationError('GOVERNANCE_DESTRUCTIVE_ROLLBACK_BLOCKED', 'New writes exist; automatic rollback would lose data.', {
        baselineRevision: manifest.baselineRevision, currentRevision: current.revision,
      });
    }
    const archivedCandidatePath = `${manifest.destinationPath}.rolled-back-candidate`;
    const restoredLegacyPath = `${manifest.destinationPath}.restored-legacy.json`;
    fs.renameSync(manifest.destinationPath, archivedCandidatePath);
    fs.copyFileSync(manifest.backupPath, restoredLegacyPath, fs.constants.COPYFILE_EXCL);
    const restoredHash = sha256(fs.readFileSync(restoredLegacyPath));
    if (restoredHash !== manifest.sourceHash) throw simulationError('GOVERNANCE_ROLLBACK_HASH_MISMATCH', 'Restored backup hash differs from source.');
    return { rolledBack: true, archivedCandidatePath, restoredLegacyPath, restoredHash };
  }
}
