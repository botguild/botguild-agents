// ---------------------------------------------------------------------------
// YouTube Data API v3 metadata (FR-4): fetch a video's snippet to auto-populate
// thumbnail headlines. `fetch` is injectable so tests never hit the live API;
// the API key comes from the wrangler secret YOUTUBE_API_KEY (10k units/day
// default quota — never request extensions, §13).
// ---------------------------------------------------------------------------

const VIDEOS_ENDPOINT = 'https://www.googleapis.com/youtube/v3/videos';

export interface VideoMetadata {
  videoId: string;
  title: string;
  channelTitle: string;
  description: string;
}

export interface YouTubeClientConfig {
  apiKey: string;
  /** Injectable for tests — never call the live API from a test. */
  fetchImpl?: typeof fetch;
}

export interface YouTubeClient {
  /** Video snippet, or null when the id is unknown / the API is unavailable. */
  fetchVideo(videoId: string): Promise<VideoMetadata | null>;
}

interface VideosListResponse {
  items?: Array<{
    id?: string;
    snippet?: { title?: string; channelTitle?: string; description?: string };
  }>;
}

export function createYouTubeClient(config: YouTubeClientConfig): YouTubeClient {
  const fetchImpl = config.fetchImpl ?? fetch;

  return {
    async fetchVideo(videoId: string): Promise<VideoMetadata | null> {
      const url = new URL(VIDEOS_ENDPOINT);
      url.searchParams.set('part', 'snippet');
      url.searchParams.set('id', videoId);
      url.searchParams.set('key', config.apiKey);

      const response = await fetchImpl(url.toString(), { method: 'GET' });
      if (!response.ok) return null;

      const body = (await response.json()) as VideosListResponse;
      const item = body.items?.[0];
      const snippet = item?.snippet;
      if (!item?.id || !snippet?.title) return null;

      return {
        videoId: item.id,
        title: snippet.title,
        channelTitle: snippet.channelTitle ?? '',
        description: snippet.description ?? '',
      };
    },
  };
}
