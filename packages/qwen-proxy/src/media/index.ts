/**
 * Media barrel — reusable media forwarder core (D9).
 *
 * Exports:
 *   - images: sizeToRatio, generateImage, editImage
 *   - videos: submitVideo, getVideoJob
 *   - video-jobs: insertVideoJob, updateVideoJob, listPendingVideoJobs, markVideoJobFailed
 *   - video-daemon: VideoPollDaemon
 */

export { sizeToRatio, generateImage, editImage, type MediaImageDeps } from "./images";
export { submitVideo, getVideoJob, type MediaVideoDeps } from "./videos";
export {
  insertVideoJob,
  getVideoJob as repoGetVideoJob,
  updateVideoJob,
  listPendingVideoJobs,
  markVideoJobFailed,
  type VideoJobRow,
} from "./video-jobs";
export { VideoPollDaemon, type VideoPollDaemonDeps } from "./video-daemon";
