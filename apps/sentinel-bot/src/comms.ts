import type { Messenger } from '@botguild/agent-core';
import type { WatchJobConfig } from './parser.ts';

export function createComms(messenger: Messenger) {
  return {
    setupConfirmed(contractId: string, job: WatchJobConfig): Promise<void> {
      const text = `Setup confirmed. Watching: ${job.targets.join(', ')}. Schedule: ${job.schedule}. Watch type: ${job.watchType}. First check running now.`;
      return messenger.send(contractId, text, 'progress_update');
    },

    firstCheckComplete(contractId: string, _job: WatchJobConfig, summary: string): Promise<void> {
      const text = `First check complete. ${summary}`;
      return messenger.send(contractId, text, 'progress_update');
    },

    changeDetected(contractId: string, target: string, diffSummary: string): Promise<void> {
      const text = `Change detected on ${target}: ${diffSummary}. Delivering milestone now.`;
      return messenger.send(contractId, text, 'progress_update');
    },

    packageStarted(contractId: string, job: WatchJobConfig, milestoneDates: string[]): Promise<void> {
      const text = `Package started. Watching: ${job.targets.join(', ')}. Schedule: ${job.schedule}. Milestone delivery dates: ${milestoneDates.join(', ')}.`;
      return messenger.send(contractId, text, 'progress_update');
    },

    weeklyMilestoneReady(contractId: string, summary: string): Promise<void> {
      const text = `Weekly report ready: ${summary}`;
      return messenger.send(contractId, text, 'progress_update');
    },
  };
}

export type Comms = ReturnType<typeof createComms>;
