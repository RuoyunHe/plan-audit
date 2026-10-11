/** Audit a proposed schedule without changing it. Compatible with browsers and Node. */
export function auditSchedule(input) {
  const violations = [];
  const summary = { taskCount: 0, completedCount: 0, blockCount: 0,
    start: null, end: null, span: 0, resourcesChecked: 0, violationCount: 0 };
  const report = (code, taskIds, message) => violations.push({ code, taskIds, message });
  const finish = () => ({ ok: violations.length === 0, violations,
    summary: { ...summary, violationCount: violations.length } });
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const amount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const idValid = value => typeof value === 'string' && value.trim().length > 0;
  const optional = (value, fallback) => value === undefined ? fallback : value;
  const approximately = (a, b) => a === b || (Number.isFinite(a) && Number.isFinite(b) &&
    Math.abs(a - b) <= 8 * Number.EPSILON * Math.max(Math.abs(a), Math.abs(b)));
  const interval = item => amount(item.start) && amount(item.end) && item.end >= item.start;
  // A final guard also turns unusual JavaScript objects (e.g. throwing getters) into diagnostics.
  try {
    if (!record(input)) {
      report('INVALID_INPUT', [], 'Expected a schedule object.');
      return finish();
    }
    const list = (value, name, code) => {
      if (Array.isArray(value)) return value;
      report(code, [], `${name} must be an array.`);
      return [];
    };
    const tasks = list(input.tasks, 'tasks', 'INVALID_INPUT');
    const blocks = list(optional(input.blocks, []), 'blocks', 'INVALID_INPUT');
    const previous = list(optional(input.previousCompleted, []), 'previousCompleted', 'INVALID_PREVIOUS_COMPLETED');
    const capacities = new Map();
    if (!record(input.capacities)) report('INVALID_INPUT', [], 'capacities must be an object.');
    else for (const [resource, value] of Object.entries(input.capacities)) {
      if (!idValid(resource) || !amount(value)) report('INVALID_CAPACITY', [], `Invalid capacity for resource "${resource}".`);
      else capacities.set(resource, value);
    }
    summary.resourcesChecked = capacities.size;
    summary.taskCount = tasks.length;
    summary.blockCount = blocks.length;
    const byId = new Map(), normalized = [], events = new Map();
    const addUsage = (resource, units, item, taskIds, token) => {
      if (!capacities.has(resource)) {
        report('MISSING_CAPACITY', taskIds, `Resource "${resource}" needs a valid capacity.`);
        return;
      }
      if (!interval(item) || item.start === item.end || units === 0) return;
      const queue = events.get(resource) ?? [];
      queue.push({ time: item.start, enter: true, units, taskIds, token },
        { time: item.end, enter: false, units, taskIds, token });
      events.set(resource, queue);
    };
    Array.from(tasks).forEach((task, index) => {
      if (!record(task)) { report('INVALID_TASK', [], `Task at index ${index} must be an object.`); return; }
      const ids = idValid(task.id) ? [task.id] : [];
      if (!ids.length) report('INVALID_ID', [], `Task at index ${index} needs a nonempty string id.`);
      else if (byId.has(task.id)) report('DUPLICATE_ID', ids, `Duplicate task id "${task.id}".`);
      else byId.set(task.id, task);
      if (!interval(task)) report('INVALID_INTERVAL', ids, 'Task start/end must be finite, nonnegative, and ordered.');
      else {
        summary.start = summary.start === null ? task.start : Math.min(summary.start, task.start);
        summary.end = summary.end === null ? task.end : Math.max(summary.end, task.end);
      }
      if (!amount(task.duration)) report('INVALID_DURATION', ids, 'Task duration must be finite and nonnegative.');
      else if (interval(task) && !approximately(task.duration, task.end - task.start)) {
        report('DURATION_MISMATCH', ids, 'Task duration must equal end minus start.');
      }
      if (task.completed !== undefined && typeof task.completed !== 'boolean') {
        report('INVALID_TASK', ids, 'completed must be a boolean when provided.');
      }
      if (task.completed === true) summary.completedCount++;
      const resources = optional(task.resources, {});
      if (!record(resources)) report('INVALID_RESOURCES', ids, 'Task resources must be an object.');
      else for (const [resource, units] of Object.entries(resources)) {
        if (!idValid(resource) || !amount(units)) report('INVALID_RESOURCE_COUNT', ids, `Invalid units for resource "${resource}".`);
        else addUsage(resource, units, task, ids, `task:${index}`);
      }
      const deps = optional(task.deps, []);
      if (!Array.isArray(deps) || [...deps].some(dep => !idValid(dep))) {
        report('INVALID_DEPENDENCIES', ids, 'deps must be an array of nonempty string ids.');
      } else normalized.push({ task, deps: [...new Set(deps)] });
    });
    for (const { task, deps } of normalized) for (const dep of deps) {
      const parent = byId.get(dep), ids = idValid(task.id) ? [dep, task.id] : [dep];
      if (!parent) report('UNKNOWN_DEPENDENCY', ids, `Dependency "${dep}" does not exist.`);
      else if (interval(task) && interval(parent) && parent.end > task.start) {
        report('DEPENDENCY_OVERLAP', ids, 'A dependency must finish before its dependent task starts.');
      }
    }
    // Iterative graph walk catches zero-duration cycles without recursion depth limits.
    const graph = new Map(normalized.filter(({ task }) => idValid(task.id)).map(({ task, deps }) => [task.id, deps]));
    const colors = new Map();
    for (const root of graph.keys()) {
      if (colors.has(root)) continue;
      const stack = [{ id: root, next: 0 }];
      colors.set(root, 1);
      while (stack.length) {
        const frame = stack[stack.length - 1], deps = graph.get(frame.id) ?? [];
        if (frame.next === deps.length) { colors.set(frame.id, 2); stack.pop(); continue; }
        const dep = deps[frame.next++];
        if (!graph.has(dep)) continue;
        if (colors.get(dep) === 1) report('DEPENDENCY_CYCLE', [frame.id, dep], 'Dependencies contain a cycle.');
        else if (!colors.has(dep)) { colors.set(dep, 1); stack.push({ id: dep, next: 0 }); }
      }
    }
    Array.from(blocks).forEach((block, index) => {
      if (!record(block) || !interval(block) || !idValid(block.resource) || !amount(block.units)) {
        report('INVALID_BLOCK', [], `Block at index ${index} needs resource, ordered finite nonnegative times, and nonnegative units.`);
        return;
      }
      addUsage(block.resource, block.units, block, [], `block:${index}`);
    });
    for (const [resource, queue] of events) {
      queue.sort((a, b) => a.time - b.time);
      const active = new Map();
      for (let i = 0; i < queue.length;) {
        const time = queue[i].time, batch = [];
        while (i < queue.length && queue[i].time === time) batch.push(queue[i++]);
        for (const event of batch) if (!event.enter) active.delete(event.token);
        for (const event of batch) if (event.enter) active.set(event.token, event);
        // Recompute to avoid subtraction drift after a large reservation ends.
        const used = [...active.values()].reduce((sum, event) => sum + event.units, 0);
        const capacity = capacities.get(resource);
        if (i < queue.length && used > capacity && !approximately(used, capacity)) {
          const taskIds = [...new Set([...active.values()].flatMap(event => event.taskIds))].sort();
          report('RESOURCE_OVERLOAD', taskIds, `Resource "${resource}" uses ${used} of ${capacity} from ${time} to ${queue[i].time}.`);
        }
      }
    }
    const previousIds = new Set();
    const sortedEntries = object => Object.entries(object).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    const frozenState = task => JSON.stringify([task.start, task.end, task.duration,
      sortedEntries(optional(task.resources, {})), [...new Set(optional(task.deps, []))].sort()]);
    for (const old of previous) {
      if (!record(old) || !idValid(old.id) || !interval(old) || !amount(old.duration) ||
        !approximately(old.duration, old.end - old.start) || !record(optional(old.resources, {})) ||
        Object.entries(optional(old.resources, {})).some(([key, value]) => !idValid(key) || !amount(value)) ||
        !Array.isArray(optional(old.deps, [])) || [...optional(old.deps, [])].some(dep => !idValid(dep)) || previousIds.has(old.id)) {
        report('INVALID_PREVIOUS_COMPLETED', [], 'Previous completed records must have unique ids and valid schedule fields.');
        continue;
      }
      previousIds.add(old.id);
      const current = byId.get(old.id);
      if (!current) report('COMPLETED_TASK_REMOVED', [old.id], 'A previously completed task was removed.');
      else if (current.completed !== true || !record(optional(current.resources, {})) || !Array.isArray(optional(current.deps, [])) ||
        frozenState(current) !== frozenState(old)) {
        report('COMPLETED_TASK_CHANGED', [old.id], 'A previously completed task changed or lost its completed flag.');
      }
    }
    summary.span = summary.start === null ? 0 : summary.end - summary.start;
  } catch {
    report('UNREADABLE_INPUT', [], 'Input could not be inspected. Supply plain JSON-compatible data.');
  }
  return finish();
}
