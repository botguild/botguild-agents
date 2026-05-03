declare module 'node-cron' {
  export interface ScheduledTask {
    stop(): void;
    start(): void;
  }

  export interface ScheduleOptions {
    scheduled?: boolean;
    timezone?: string;
    recoverMissedExecutions?: boolean;
    runOnInit?: boolean;
    name?: string;
  }

  export function schedule(
    expression: string,
    func: () => void | Promise<void>,
    options?: ScheduleOptions,
  ): ScheduledTask;

  export function validate(expression: string): boolean;

  export function getTasks(): Map<string, ScheduledTask>;
}
