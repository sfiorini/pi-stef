export {
  LockHeldError,
  acquireLock,
  isLockStale,
  readLockMetadata,
  releaseLock,
  sweepStaleLockDirs,
} from "@pi-stef/agent-workflows";

export type { LockMetadata } from "@pi-stef/agent-workflows";
