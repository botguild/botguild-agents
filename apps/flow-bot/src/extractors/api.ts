import type { Logger } from 'pino';

export type PaginationStyle = 'offset' | 'cursor' | 'link-header';
export type AuthStyle = 'bearer' | 'api-key-header' | 'basic';

export interface ApiAuth {
  style: AuthStyle;
  token?: string;
  headerName?: string;
  username?: string;
}

export interface ApiExtractorConfig {
  url: string;
  auth?: ApiAuth;
  paginationStyle: PaginationStyle;
  pageSize?: number;
  maxRecords?: number;
  cursorField?: string;
  recordsField?: string;
  logger: Logger;
}

export interface ApiExtractResult {
  records: Record<string, unknown>[];
  pagesFetched: number;
  totalRecords: number;
  summary: string;
}

function buildAuthHeaders(auth: ApiAuth): Record<string, string> {
  switch (auth.style) {
    case 'bearer':
      return { Authorization: `Bearer ${auth.token}` };
    case 'api-key-header':
      return { [auth.headerName!]: auth.token! };
    case 'basic': {
      const encoded = btoa(`${auth.username}:${auth.token}`);
      return { Authorization: `Basic ${encoded}` };
    }
  }
}

function parseLinkHeader(header: string): string | null {
  for (const part of header.split(',')) {
    const [urlPart, relPart] = part.trim().split(';');
    if (relPart?.trim() === 'rel="next"') {
      const match = urlPart?.trim().match(/^<(.+)>$/);
      if (match) return match[1];
    }
  }
  return null;
}

function extractRecords(
  body: unknown,
  recordsField: string | undefined,
): Record<string, unknown>[] {
  if (recordsField) {
    const obj = body as Record<string, unknown>;
    const field = obj[recordsField];
    if (Array.isArray(field)) return field as Record<string, unknown>[];
    return [];
  }
  if (Array.isArray(body)) return body as Record<string, unknown>[];
  return [];
}

export async function extractApi(config: ApiExtractorConfig): Promise<ApiExtractResult> {
  const {
    url,
    auth,
    paginationStyle,
    pageSize = 100,
    maxRecords = 10000,
    cursorField,
    recordsField,
    logger,
  } = config;

  const authHeaders = auth ? buildAuthHeaders(auth) : {};
  const records: Record<string, unknown>[] = [];
  let pagesFetched = 0;
  let lastProgressLogPage = 0;
  let lastProgressLogRecord = 0;

  async function fetchPage(
    fetchUrl: string,
  ): Promise<{ body: unknown; linkHeader: string | null }> {
    const response = await fetch(fetchUrl, { headers: authHeaders });
    if (!response.ok) {
      throw new Error(
        `API request failed: ${response.status} ${response.statusText} for ${fetchUrl}`,
      );
    }
    const linkHeader = response.headers.get('Link');
    const body = await response.json();
    return { body, linkHeader };
  }

  function maybeLogProgress() {
    const pagesSinceLast = pagesFetched - lastProgressLogPage;
    const recordsSinceLast = records.length - lastProgressLogRecord;
    if (pagesSinceLast >= 5 || recordsSinceLast >= 1000) {
      logger.info({ pagesFetched, totalRecords: records.length }, 'progress_update');
      lastProgressLogPage = pagesFetched;
      lastProgressLogRecord = records.length;
    }
  }

  if (paginationStyle === 'offset') {
    let page = 1;
    while (records.length < maxRecords) {
      const separator = url.includes('?') ? '&' : '?';
      const fetchUrl = `${url}${separator}page=${page}&limit=${pageSize}`;
      const { body } = await fetchPage(fetchUrl);
      const pageRecords = extractRecords(body, recordsField);
      pagesFetched++;

      const remaining = maxRecords - records.length;
      records.push(...pageRecords.slice(0, remaining));
      maybeLogProgress();

      if (pageRecords.length === 0 || pageRecords.length < pageSize) break;
      page++;
    }
  } else if (paginationStyle === 'cursor') {
    let cursor: string | null = null;
    let isFirst = true;
    while (records.length < maxRecords) {
      let fetchUrl = url;
      if (!isFirst && cursor) {
        const separator = url.includes('?') ? '&' : '?';
        fetchUrl = `${url}${separator}after=${encodeURIComponent(cursor)}`;
      }
      isFirst = false;

      const { body } = await fetchPage(fetchUrl);
      const pageRecords = extractRecords(body, recordsField);
      pagesFetched++;

      const remaining = maxRecords - records.length;
      records.push(...pageRecords.slice(0, remaining));
      maybeLogProgress();

      const bodyObj = body as Record<string, unknown>;
      const nextCursor = cursorField ? bodyObj[cursorField] : undefined;
      if (!nextCursor || typeof nextCursor !== 'string') break;
      cursor = nextCursor;
    }
  } else {
    let nextUrl: string | null = url;
    while (nextUrl && records.length < maxRecords) {
      const { body, linkHeader } = await fetchPage(nextUrl);
      const pageRecords = extractRecords(body, recordsField);
      pagesFetched++;

      const remaining = maxRecords - records.length;
      records.push(...pageRecords.slice(0, remaining));
      maybeLogProgress();

      nextUrl = linkHeader ? parseLinkHeader(linkHeader) : null;
    }
  }

  const totalRecords = records.length;
  const summary = `Fetched ${totalRecords} records across ${pagesFetched} pages from ${url}.`;

  return { records, pagesFetched, totalRecords, summary };
}
