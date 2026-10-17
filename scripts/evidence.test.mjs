import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureWorkspace, classifyBackgroundTermination, collectEvidence, readEvidence, saveEvidence } from '../lib/evidence.js'

function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'agy-review-test-'))
  try { return fn(dir) } finally { rmSync(dir, { force: true, recursive: true }) }
}
function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
}

test('non-Git workspace: independent added/modified/deleted evidence, no fabricated tests', () => fixture(dir => {
  writeFileSync(join(dir, 'keep.ts'), 'first\n')
  writeFileSync(join(dir, 'remove.ts'), 'delete me\n')
  const before = captureWorkspace(dir)
  assert.equal(before.git, false)
  writeFileSync(join(dir, 'keep.ts'), 'second\n')
  writeFileSync(join(dir, 'added.ts'), 'new file\n')
  unlinkSync(join(dir, 'remove.ts'))
  const report = collectEvidence(before, 'task-nongit', 'completed', 'conv-1')
  assert.equal(report.review_status, 'pending')
  assert.equal(report.execution_status, 'completed')
  assert.deepEqual(report.changed_files.map(x => [x.path, x.change]), [
    ['added.ts', 'added'], ['keep.ts', 'modified'], ['remove.ts', 'deleted'],
  ])
  assert.equal(report.diff_summary.changed_files_total, 3)
  assert.equal(report.diff_summary.added_lines, null)
  assert.deepEqual(report.test_results, [])
  assert.deepEqual(report.artifacts, [])
  assert.equal(report.evidence_complete, true)
  const registry = join(dir, 'evidence-store')
  const path = saveEvidence(report, registry)
  assert.ok(readFileSync(path, 'utf8').includes('"task_id": "task-nongit"'))
  assert.deepEqual(readEvidence('task-nongit', registry), report)
  assert.equal(readEvidence('other-task', registry), undefined)
}))

test('Git workspace: baseline commit, tracked changes, untracked additions', () => fixture(dir => {
  git(dir, 'init', '-q')
  writeFileSync(join(dir, 'existing.ts'), 'hello\n')
  git(dir, 'add', '--', 'existing.ts')
  git(dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'initial')
  const before = captureWorkspace(dir)
  assert.equal(before.git, true)
  assert.equal(before.baselineDirty, false)
  assert.ok(before.baselineCommit)
  writeFileSync(join(dir, 'existing.ts'), 'hello\nworld\n')
  writeFileSync(join(dir, 'untracked.ts'), 'new\n')
  const report = collectEvidence(before, 'task-git', 'completed')
  assert.equal(report.diff_summary.added_files, 1)
  assert.equal(report.diff_summary.modified_files, 1)
  assert.equal(report.diff_summary.deleted_files, 0)
  assert.equal(report.diff_summary.added_lines, 1) // Git numstat excludes untracked
  assert.equal(report.diff_summary.includes_preexisting_changes, false)
  assert.equal(report.baseline_commit, before.baselineCommit)
}))

test('Dirty Git baseline is flagged, never claimed to be clean task-only Git diff', () => fixture(dir => {
  git(dir, 'init', '-q')
  writeFileSync(join(dir, 'preexisting.txt'), 'v1\n')
  git(dir, 'add', '--', 'preexisting.txt')
  git(dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base')
  writeFileSync(join(dir, 'preexisting.txt'), 'v2\n')
  const before = captureWorkspace(dir)
  writeFileSync(join(dir, 'preexisting.txt'), 'v3\n')
  const report = collectEvidence(before, 'dirty', 'failed', undefined, 'API error')
  assert.equal(before.baselineDirty, true)
  assert.equal(report.diff_summary.includes_preexisting_changes, true)
  assert.ok(report.warnings.some(w => /preexisting changes/.test(w)))
  assert.deepEqual(report.changed_files.map(x => x.path), ['preexisting.txt'])
  assert.equal(report.error, 'API error')
  assert.equal(report.review_status, 'pending')
}))

test('Background termination classification: failure cannot masquerade as success', () => {
  const input = { timedOut: false, cancelledByRequest: false, signal: null, exitCode: 0, finalStatus: 'SUCCESS' }
  assert.deepEqual(classifyBackgroundTermination(input), { jobStatus: 'completed', evidenceStatus: 'completed' })
  assert.deepEqual(classifyBackgroundTermination({ ...input, finalStatus: 'ERROR' }), { jobStatus: 'failed', evidenceStatus: 'failed' })
  assert.deepEqual(classifyBackgroundTermination({ ...input, exitCode: 1 }), { jobStatus: 'failed', evidenceStatus: 'failed' })
  assert.deepEqual(classifyBackgroundTermination({ ...input, finalStatus: undefined }), { jobStatus: 'failed', evidenceStatus: 'failed' })
  assert.deepEqual(classifyBackgroundTermination({ ...input, cancelledByRequest: true }), { jobStatus: 'killed', evidenceStatus: 'cancelled' })
  assert.deepEqual(classifyBackgroundTermination({ ...input, timedOut: true }), { jobStatus: 'killed', evidenceStatus: 'timeout' })
  assert.deepEqual(classifyBackgroundTermination({ ...input, signal: 'SIGTERM' }), { jobStatus: 'killed', evidenceStatus: 'failed' })
})
