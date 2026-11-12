// in app/scheduled-time.server.ts
// The time a run of a daily or hourly schedule was scheduled for: the most recent one at or before now.
// Container Apps passes no scheduled time to a job, so the job computes it, and a run that starts late
// or retries gets the same time, and so the same message id, as its first attempt.
export function lastScheduledRun(schedule: string, now = new Date()): Date {
  const [minute, hour, ...rest] = schedule.trim().split(/\s+/);
  const daily = /^\d+$/.test(hour ?? "");
  if (!/^\d+$/.test(minute ?? "") || !(daily || hour === "*") || rest.length !== 3 || rest.some((field) => field !== "*")) {
    throw new Error(`lastScheduledRun reads "M H * * *" and "M * * * *" in UTC, not "${schedule}"`);
  }
  const run = new Date(now);
  run.setUTCMinutes(Number(minute), 0, 0);
  if (daily) {
    run.setUTCHours(Number(hour));
    if (run > now) run.setUTCDate(run.getUTCDate() - 1);
  } else if (run > now) {
    run.setUTCHours(run.getUTCHours() - 1);
  }
  return run;
}
