# Plan Audit

A small, zero-dependency schedule invariant checker for JavaScript agents and applications.
It accepts a proposed plan and returns deterministic diagnostics. It does not generate a
schedule, call an AI service, execute tasks, or modify the input.

An agent can produce a convincing explanation while double-booking a person, moving an
already completed task, or starting work before a prerequisite is finished. Check its
structured output before showing or executing the plan. The same checker works for dinner
preparation, build pipelines, shared equipment, and appointment slots.

## Use

```js
import { auditSchedule } from './index.mjs';

const result = auditSchedule({
  tasks: [
    { id: 'prepare', start: 0, end: 5, duration: 5, resources: { worker: 1 } },
    { id: 'assemble', start: 5, end: 12, duration: 7,
      resources: { worker: 1 }, deps: ['prepare'] }
  ],
  capacities: { worker: 1 }
});
console.log(result.ok); // true
```

The same import works in a browser `<script type="module">` served over HTTP. There are no
runtime dependencies or platform APIs in `index.mjs`. With Node 18+, reproduce from the
**complete repository**, which contains the tests; the runtime package excludes `test/`:

```sh
git clone https://github.com/RuoyunHe/plan-audit.git
cd plan-audit
node cli.mjs examples/dinner-plan.json
npm test
```

No `npm install` is needed. Expect **13 passing tests**, including the CLI rejection path.
A test run reporting zero tests is not verification; use the complete repository checkout.

The CLI reads exactly one JSON file path, never stdin. Exit status is 0 for a valid schedule,
1 for a schedule with violations, and 2 for a usage, file, or JSON parsing error. It writes
the report to stdout; file and parsing errors go to stderr without echoing file contents.

## Reproduce a shared laboratory conflict

```sh
node cli.mjs examples/shared-lab-valid.json
node cli.mjs examples/shared-lab-overload.json
```

These original fictional fixtures use minutes from a common origin: one technician loads
three batches, two centrifuges process them, and one spectrometer measures them after an
initial reservation. They demonstrate dependencies, half-open boundaries, and frozen work.
The first exits **0** with `ok: true`. The second moves only `spin-c` earlier and exits **1**
with `RESOURCE_OVERLOAD`: `spin-a`, `spin-b`, and `spin-c` need three centrifuges from minute
6 to 12, but only two exist. This nonzero exit is the expected rejection, not a CLI failure.
These are scheduling examples, not laboratory protocols or validated scientific durations.

## Input contract

- `tasks` is an array; `capacities` is an object mapping resource names to capacity.
- Each task requires a unique nonempty string `id` and numeric `start`, `end`, `duration`.
  Values must be finite and nonnegative; `end >= start`, and `duration = end - start`.
- Use any single consistent time unit and origin throughout a schedule. Strings and dates
  are not coerced. A tiny relative floating-point tolerance is used for duration and capacity.
- Task `resources` defaults to `{}`; `deps` defaults to `[]`. Resource quantities and
  capacities may be fractional or zero, but must be finite and nonnegative. Every referenced
  resource needs an explicit valid capacity, even if its requested units are zero.
- Dependencies identify existing tasks. A prerequisite must end at or before the dependent
  task starts. Cycles, including zero-duration cycles, are invalid.
- Intervals are half-open: `[start, end)`. Adjacent reservations do not overlap. A zero-length
  task consumes no resource capacity, though it still participates in dependency checks.
- Optional `blocks` is an array of `{resource, start, end, units}` reservations, such as a
  worker's break or maintenance window. Blocks and tasks share the same capacity budget.
- Optional `previousCompleted` is an array of prior task records to freeze. Every record
  must remain present, have `completed: true` in the new plan, and retain its exact times,
  duration, resource assignments, and dependency set. Key/dependency order does not matter.
  The old record's `completed` flag is not required: membership in this array marks it frozen.
- Extra task metadata is ignored, so applications can attach labels and domain fields.

Empty `tasks` with valid capacities is valid. Input is not mutated. Invalid input produces
diagnostics rather than throwing; use plain JSON-compatible objects for predictable results.

## Result

```js
{
  ok: false,
  violations: [{
    code: 'RESOURCE_OVERLOAD',
    taskIds: ['prepare', 'assemble'],
    message: 'Resource "worker" uses 2 of 1 from 4 to 5.'
  }],
  summary: { taskCount: 2, completedCount: 0, blockCount: 0,
    start: 0, end: 12, span: 12, resourcesChecked: 1, violationCount: 1 }
}
```

`summary.start/end/span` describe valid task intervals, excluding blocks; empty plans use
`null/null/0`. An overload diagnostic is emitted for each conflicting interval between
successive resource events. Its task ids include all active tasks; reservations from blocks
can produce a violation with no task ids. This catches aggregate overload (three simultaneous
one-unit tasks on a two-unit resource), which a pairwise overlap check can miss.

Other codes include `INVALID_INPUT`, `INVALID_TASK`, `INVALID_ID`, `DUPLICATE_ID`,
`INVALID_INTERVAL`, `INVALID_DURATION`, `DURATION_MISMATCH`, `INVALID_RESOURCES`,
`INVALID_RESOURCE_COUNT`, `INVALID_CAPACITY`, `MISSING_CAPACITY`, `INVALID_DEPENDENCIES`,
`UNKNOWN_DEPENDENCY`, `DEPENDENCY_OVERLAP`, `DEPENDENCY_CYCLE`, `INVALID_BLOCK`,
`INVALID_PREVIOUS_COMPLETED`, `COMPLETED_TASK_REMOVED`, `COMPLETED_TASK_CHANGED`, and
`UNREADABLE_INPUT`. Several may describe the same invalid task. Invalid fields are skipped
where necessary so other checks can continue; `ok: false` must not be treated as a partial pass.

This library verifies only the supplied model. It does not establish food safety, task
quality, real-world duration accuracy, authorization, feasibility beyond these invariants,
or optimality. An application must validate its own domain constraints separately.

## Development and license

Tests cover malformed input, adversarial overlap, dependencies, temporal boundaries,
completed-task preservation, dinner, and shared-laboratory CLI examples. MIT © 2026 RuoyunHe.
