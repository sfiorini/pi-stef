/**
 * Media barrel — reusable media forwarder core.
 *
 * Exports:
 *   - images: sizeToRatio, generateImage, editImage
 *   - videos: generateVideo (sync — blocks until URL available)
 */

export { sizeToRatio, generateImage, editImage, type MediaImageDeps } from "./images";
export { generateVideo, type MediaVideoDeps } from "./videos";
