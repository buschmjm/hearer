/**
 * Recurring jobs. Each schedule enqueues its job under the unique key `schedule:<type>`, so a
 * slow job never piles up copies: while one is queued or running, further ticks are no-ops.
 */
export type ScheduleSpec = {
  type: string;
  payload?: unknown;
  /**
   * Distinguishes several schedules of one job type (e.g. an incremental and a nightly full
   * sync). The unique key becomes `schedule:<type>:<key>`; without it, `schedule:<type>`.
   */
  key?: string;
} & (
  | {
      /** Interval in ms. Enqueued once at start, then on every interval. */
      every: number;
    }
  | {
      /** Server-local hour of the day (0-23). Not enqueued at start; first run at the next occurrence. */
      dailyAtHour: number;
    }
);

export interface SchedulerOptions {
  enqueue: (spec: ScheduleSpec, uniqueKey: string) => void;
  now: () => number;
  onError: (err: unknown, spec: ScheduleSpec) => void;
}

export function scheduleKey(spec: Pick<ScheduleSpec, 'type' | 'key'>): string {
  return spec.key === undefined ? `schedule:${spec.type}` : `schedule:${spec.type}:${spec.key}`;
}

/** Next local-time occurrence of `hour:00` strictly after `after` (ms). */
export function nextDailyRun(after: number, hour: number): number {
  const next = new Date(after);
  next.setHours(hour, 0, 0, 0);
  if (next.getTime() <= after) next.setDate(next.getDate() + 1);
  return next.getTime();
}

export class Scheduler {
  readonly #opts: SchedulerOptions;
  readonly #specs: ScheduleSpec[] = [];
  readonly #timers = new Map<ScheduleSpec, NodeJS.Timeout>();
  #running = false;

  constructor(opts: SchedulerOptions) {
    this.#opts = opts;
  }

  add(spec: ScheduleSpec): void {
    if ('every' in spec) {
      if (!(spec.every > 0)) throw new RangeError(`schedule ${spec.type}: every must be > 0`);
    } else if (
      !Number.isInteger(spec.dailyAtHour) ||
      spec.dailyAtHour < 0 ||
      spec.dailyAtHour > 23
    ) {
      throw new RangeError(`schedule ${spec.type}: dailyAtHour must be an integer 0-23`);
    }
    if (this.#specs.some((s) => scheduleKey(s) === scheduleKey(spec))) {
      throw new Error(`schedule already exists for ${scheduleKey(spec)}`);
    }
    this.#specs.push(spec);
    if (this.#running) this.#arm(spec, true);
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    for (const spec of this.#specs) this.#arm(spec, true);
  }

  stop(): void {
    this.#running = false;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
  }

  #fire(spec: ScheduleSpec): void {
    try {
      this.#opts.enqueue(spec, scheduleKey(spec));
    } catch (err) {
      this.#opts.onError(err, spec);
    }
  }

  #arm(spec: ScheduleSpec, initial: boolean): void {
    if (!this.#running) return;
    let delay: number;
    if ('every' in spec) {
      if (initial) this.#fire(spec);
      delay = spec.every;
    } else {
      delay = nextDailyRun(this.#opts.now(), spec.dailyAtHour) - this.#opts.now();
    }
    const timer = setTimeout(() => {
      this.#fire(spec);
      this.#arm(spec, false);
    }, delay);
    timer.unref();
    this.#timers.set(spec, timer);
  }
}
