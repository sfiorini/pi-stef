import type { UpstreamClient, ImageResult } from "../upstream/client";
import type { RetryDeps } from "../pool/retry";
import type { withPoolRetry as WithPoolRetry } from "../pool/retry";

export interface MediaVideoDeps extends RetryDeps {
  client: Pick<UpstreamClient, "videoGeneration">;
  retry: typeof WithPoolRetry;
}

/**
 * Synchronous video generation via upstream.
 * Blocks until the video URL is available; returns {created, urls}.
 */
export async function generateVideo(
  deps: MediaVideoDeps,
  params: { prompt: string; size?: string },
): Promise<ImageResult> {
  return deps.retry(deps, async (_accountId, bearer) => {
    return deps.client.videoGeneration(bearer, {
      prompt: params.prompt,
      ...(params.size ? { size: params.size } : {}),
    });
  });
}
