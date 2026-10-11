import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { auditSchedule } from '../index.mjs';

const task = (id, start = 0, end = 10, extra = {}) =>
  ({ id, start, end, duration: end - start, resources: { cook: 1 }, ...extra });
const plan = (tasks = [], extra = {}) => ({ tasks, capacities: { cook: 1 }, ...extra });
const codes = value => auditSchedule(value).violations.map(v => v.code);
const has = (value, code) => assert.ok(codes(value).includes(code), `Expected ${code}`);

test('empty schedules and adjacent half-open tasks pass', () => {
  assert.equal(auditSchedule(plan()).ok, true);
  assert.equal(auditSchedule(plan([task('a', 0, 10), task('b', 10, 20)])).ok, true);
});
test('aggregate sweep catches three tasks on capacity two', () => {
  const result = auditSchedule(plan([task('a', 0, 10), task('b', 2, 8), task('c', 4, 6)], { capacities: { cook: 2 } }));
  assert.deepEqual(result.violations.map(v => [v.code, v.taskIds]), [['RESOURCE_OVERLOAD', ['a', 'b', 'c']]]);
  assert.match(result.violations[0].message, /from 4 to 6/);
});
test('simultaneous releases precede acquisitions, zero-duration tasks reserve nothing', () => {
  const tasks = [task('a', 0, 2), task('b', 2, 4), task('instant', 2, 2, { resources: { cook: 100 } })];
  assert.equal(auditSchedule(plan(tasks)).ok, true);
});
test('blocks share capacity, including blocks without any tasks', () => {
  const block = { resource: 'cook', start: 0, end: 5, units: 1 };
  has(plan([task('a', 2, 3)], { blocks: [block] }), 'RESOURCE_OVERLOAD');
  has(plan([], { blocks: [block, block] }), 'RESOURCE_OVERLOAD');
  assert.equal(auditSchedule(plan([task('a', 5, 6)], { blocks: [block] })).ok, true);
});
test('negative, nonfinite, reversed, and inconsistent intervals fail', () => {
  for (const start of [-1, Infinity, NaN, '0']) has(plan([task('bad', start, 3)]), 'INVALID_INTERVAL');
  has(plan([task('reverse', 3, 2)]), 'INVALID_INTERVAL');
  has(plan([task('duration', 0, 2, { duration: 1 })]), 'DURATION_MISMATCH');
  for (const duration of [-1, Infinity, NaN, '2', null]) has(plan([task('a', 0, 2, { duration })]), 'INVALID_DURATION');
});
test('identifiers, resource quantities, capacities, and shapes are validated', () => {
  has(plan([task('same'), task('same')]), 'DUPLICATE_ID');
  has(plan([task(' ')]), 'INVALID_ID');
  for (const units of [-1, NaN, Infinity, '1', null]) has(plan([task('a', 0, 1, { resources: { cook: units } })]), 'INVALID_RESOURCE_COUNT');
  has(plan([task('a')], { capacities: {} }), 'MISSING_CAPACITY');
  has(plan([], { capacities: { cook: -1 } }), 'INVALID_CAPACITY');
  has(plan([task('a', 0, 1, { resources: [] })]), 'INVALID_RESOURCES');
  has(plan([null]), 'INVALID_TASK');
  has(plan(Array(1)), 'INVALID_TASK');
  has(plan([task('a', 0, 1, { resources: null })]), 'INVALID_RESOURCES');
  has(plan([task('a', 0, 1, { deps: null })]), 'INVALID_DEPENDENCIES');
  has(plan([task('a', 0, 1, { deps: Array(1) })]), 'INVALID_DEPENDENCIES');
  has(plan([], { blocks: null }), 'INVALID_INPUT');
  has(plan([], { blocks: Array(1) }), 'INVALID_BLOCK');
  for (const invalid of [null, undefined, [], 'schedule', {}, { tasks: {}, capacities: {} }]) assert.equal(auditSchedule(invalid).ok, false);
  has(plan([], { blocks: [{ resource: 'cook', start: 4, end: 1, units: 1 }] }), 'INVALID_BLOCK');
  has(plan([], { blocks: [{ resource: 'oven', start: 0, end: 1, units: 1 }] }), 'MISSING_CAPACITY');
});
test('dependencies require existing finished tasks and cannot cycle', () => {
  has(plan([task('a', 0, 5), task('b', 4, 6, { deps: ['a'] })]), 'DEPENDENCY_OVERLAP');
  assert.equal(auditSchedule(plan([task('a', 0, 5), task('b', 5, 6, { deps: ['a'] })])).ok, true);
  has(plan([task('a', 0, 1, { deps: ['absent'] })]), 'UNKNOWN_DEPENDENCY');
  has(plan([task('a', 0, 1, { deps: [1] })]), 'INVALID_DEPENDENCIES');
  has(plan([task('a', 0, 0, { deps: ['b'] }), task('b', 0, 0, { deps: ['a'] })]), 'DEPENDENCY_CYCLE');
  has(plan([task('a', 0, 0, { deps: ['a'] })]), 'DEPENDENCY_CYCLE');
});
test('completed tasks cannot be removed, rescheduled, uncompleted, or reassigned', () => {
  const original = task('done', 0, 2, { completed: true });
  const frozen = current => plan(current, { previousCompleted: [original] });
  assert.equal(auditSchedule(frozen([structuredClone(original)])).ok, true);
  has(frozen([]), 'COMPLETED_TASK_REMOVED');
  for (const changes of [{ start: 1, end: 3 }, { completed: false }, { resources: {} }, { duration: 3 }, { deps: ['missing'] }]) {
    has(frozen([{ ...original, ...changes }]), 'COMPLETED_TASK_CHANGED');
  }
  has(plan([], { previousCompleted: [{ id: 'bad' }] }), 'INVALID_PREVIOUS_COMPLETED');
});
test('freezing compares resource/dependency content rather than insertion order', () => {
  const old = task('done', 1, 2, { resources: { cook: 1, oven: 0 }, deps: ['a', 'b'], completed: true });
  const current = { ...old, resources: { oven: 0, cook: 1 }, deps: ['b', 'a', 'a'], label: 'new label' };
  assert.equal(auditSchedule(plan([task('a', 0, 0), task('b', 0, 0), current],
    { capacities: { cook: 1, oven: 0 }, previousCompleted: [old] })).ok, true);
});
test('fractional quantities tolerate arithmetic noise, real overloads still fail', () => {
  const tasks = [task('a', 0, 1, { resources: { cook: 0.1 } }), task('b', 0, 1, { resources: { cook: 0.2 } })];
  assert.equal(auditSchedule(plan(tasks, { capacities: { cook: 0.3 } })).ok, true);
  has(plan(tasks, { capacities: { cook: 0.299 } }), 'RESOURCE_OVERLOAD');
  has(plan([task('a', 0, 1, { resources: { cook: 1e-20 } })], { capacities: { cook: 0 } }), 'RESOURCE_OVERLOAD');
});
test('unusual names are ordinary resource/id keys and input is unchanged', () => {
  const value = JSON.parse('{"tasks":[{"id":"__proto__","start":0,"end":1,"duration":1,"resources":{"__proto__":1}}],"capacities":{"__proto__":1}}');
  const before = JSON.stringify(value);
  assert.equal(auditSchedule(value).ok, true);
  assert.equal(JSON.stringify(value), before);
  assert.doesNotThrow(() => auditSchedule({ get tasks() { throw Error('private'); } }));
});
test('dinner example passes; CLI outputs reports and rejects stdin', async () => {
  const example = new URL('../examples/dinner-plan.json', import.meta.url);
  const report = auditSchedule(JSON.parse(await readFile(example, 'utf8')));
  assert.equal(report.ok, true);
  assert.deepEqual([report.summary.taskCount, report.summary.completedCount, report.summary.span], [5, 1, 25]);
  const cli = new URL('../cli.mjs', import.meta.url);
  const { fileURLToPath } = await import('node:url');
  const result = spawnSync(process.execPath, [fileURLToPath(cli), fileURLToPath(example)], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).ok, true);
  assert.equal(spawnSync(process.execPath, [fileURLToPath(cli), '-']).status, 2);
});
