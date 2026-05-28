import type { ResolvedExecutionStrategy, ResolvedStoryWave } from "../plan/execution-strategy";
import type { ParsedMilestone, ParsedStory } from "../plan/tracker";
import type { ImplementMode, ResolvedDefaults } from "../config/schema";

export interface ScheduledStoryLane {
  milestoneId: string;
  story: ParsedStory;
  waveId: string;
  writeSet: string[];
}

export interface ScheduledStoryBatch {
  id: string;
  waveId: string;
  stories: ScheduledStoryLane[];
}

export interface ScheduledMilestoneLane {
  milestone: ParsedMilestone;
  waveId: string;
  storyBatches: ScheduledStoryBatch[];
}

export interface ScheduledMilestoneBatch {
  id: string;
  waveId: string;
  milestones: ScheduledMilestoneLane[];
}

export interface ExecutionSchedule {
  enabled: boolean;
  source: ResolvedExecutionStrategy["source"];
  warnings: string[];
  milestoneBatches: ScheduledMilestoneBatch[];
  skippedStories: string[];
}

export interface PlanExecutionWavesInput {
  strategy: ResolvedExecutionStrategy;
  milestones: ParsedMilestone[];
  parallel: ResolvedDefaults["parallel"];
  mode: ImplementMode;
  signal?: AbortSignal;
}

export function planExecutionWaves(input: PlanExecutionWavesInput): ExecutionSchedule {
  throwIfAborted(input.signal);
  const byMilestone = new Map(input.milestones.map((milestone) => [milestone.id, milestone]));
  const pendingMilestoneIds = new Set(
    input.milestones
      .filter((milestone) => milestone.stories.some(isRunnableStory))
      .map((milestone) => milestone.id),
  );
  const orderedPendingMilestoneIds = input.strategy.milestoneWaves
    .flatMap((wave) => wave.milestones)
    .filter((milestoneId) => pendingMilestoneIds.has(milestoneId));
  // Keep every pending milestone visible to the execution schedule regardless
  // of implement mode. In single-milestone mode, batch them one at a time so
  // the inter-milestone gate can stop before the next milestone instead of
  // silently dropping later pending milestones from the run summary.
  const allowedMilestones = new Set(orderedPendingMilestoneIds);
  const skippedStories: string[] = [];
  const milestoneBatches: ScheduledMilestoneBatch[] = [];

  const globalMilestoneCap = input.mode === "single-milestone"
    ? 1
    : Math.max(1, Math.min(
      input.strategy.maxParallelMilestones,
      input.parallel.max_milestones,
    ));
  const globalStoryCap = Math.max(1, Math.min(
    input.strategy.maxParallelStoriesPerMilestone,
    input.parallel.max_stories_per_milestone,
  ));

  for (const milestoneWave of input.strategy.milestoneWaves) {
    throwIfAborted(input.signal);
    const waveMilestones = milestoneWave.milestones
      .filter((milestoneId) => allowedMilestones.has(milestoneId))
      .map((milestoneId) => {
        const milestone = byMilestone.get(milestoneId);
        if (!milestone) return undefined;
        return {
          milestone,
          waveId: milestoneWave.id,
          storyBatches: scheduleStoryBatches({
            milestone,
            strategy: input.strategy,
            globalStoryCap,
            skippedStories,
          }),
        } satisfies ScheduledMilestoneLane;
      })
      .filter((lane): lane is ScheduledMilestoneLane => !!lane && lane.storyBatches.length > 0);
    const cap = Math.max(1, Math.min(milestoneWave.maxParallel, globalMilestoneCap));
    for (const [batchIndex, batch] of chunk(waveMilestones, cap).entries()) {
      milestoneBatches.push({
        id: `${milestoneWave.id}.${batchIndex + 1}`,
        waveId: milestoneWave.id,
        milestones: batch,
      });
    }
  }

  return {
    enabled: input.parallel.enabled && input.strategy.source !== "sequential-fallback",
    source: input.strategy.source,
    warnings: [...input.strategy.warnings],
    milestoneBatches,
    skippedStories,
  };
}

function scheduleStoryBatches(input: {
  milestone: ParsedMilestone;
  strategy: ResolvedExecutionStrategy;
  globalStoryCap: number;
  skippedStories: string[];
}): ScheduledStoryBatch[] {
  const byStory = new Map(input.milestone.stories.map((story) => [story.id, story]));
  const runnableStories = new Set(input.milestone.stories.filter(isRunnableStory).map((story) => story.id));
  for (const story of input.milestone.stories) {
    if (!isRunnableStory(story)) input.skippedStories.push(story.id);
  }
  const storyStrategy = input.strategy.stories[input.milestone.id];
  if (!storyStrategy) return [];
  const out: ScheduledStoryBatch[] = [];
  for (const storyWave of storyStrategy.storyWaves) {
    const cap = storyWaveCap(storyWave, storyStrategy.maxParallelStories, input.globalStoryCap);
    const lanes = storyWave.stories
      .filter((storyId) => runnableStories.has(storyId))
      .map((storyId) => ({
        milestoneId: input.milestone.id,
        story: byStory.get(storyId)!,
        waveId: storyWave.id,
        writeSet: storyWave.writeSets[storyId] ?? [],
      }));
    for (const [batchIndex, batch] of chunk(lanes, cap).entries()) {
      out.push({
        id: `${input.milestone.id}.${storyWave.id}.${batchIndex + 1}`,
        waveId: storyWave.id,
        stories: batch,
      });
    }
  }
  return out;
}

function storyWaveCap(wave: ResolvedStoryWave, milestoneCap: number, globalCap: number): number {
  return Math.max(1, Math.min(wave.maxParallel, milestoneCap, globalCap));
}

function isRunnableStory(story: ParsedStory): boolean {
  return story.status === "pending" || story.status === "in-dev" || story.status === "needs-rework";
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("sf_team_implement: execution scheduling aborted");
  }
}
