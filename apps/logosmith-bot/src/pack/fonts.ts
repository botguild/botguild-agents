// Google Fonts pairing (FR-12). ADVISORY ONLY — §9 lists this as non-blocking:
// it is a recommendation with license metadata, never a warranted property, and
// an outage must never fail a job. Hence the pinned fallback pairing.

import type { FetchLike } from '../types.js';

export interface FontRef {
  family: string;
  category: string;
  license: string;
  url: string;
}

export interface FontPairing {
  heading: FontRef;
  body: FontRef;
  note: string;
}

const ADVISORY_NOTE =
  'Advisory recommendation only. Both families are served by Google Fonts; open each specimen page ' +
  'to confirm its licence before redistributing. Font choice is not covered by the warranty.';

const googleUrl = (family: string): string =>
  `https://fonts.google.com/specimen/${encodeURIComponent(family.replace(/\s+/g, '+'))}`;

/**
 * VERIFIED LIVE 2026-07-30: the Google Fonts API returns NO licence field —
 * items carry only family/variants/subsets/version/lastModified/files/category/
 * kind/menu. The catalogue is NOT uniformly OFL (it also contains Apache-2.0
 * and Ubuntu Font Licence families), so a hardcoded licence string on a
 * dynamically-selected font would be an unverified assertion shipped inside
 * brand.json. Say where to check instead of claiming a licence we did not read.
 */
const ref = (family: string, category: string): FontRef => ({
  family,
  category,
  license: 'See the specimen page for this family\'s licence.',
  url: googleUrl(family),
});

/**
 * The pinned fallback pairing. These two families' licences ARE verified (both
 * SIL OFL 1.1, confirmed at Phase 0 and recorded in the vendor-terms decision
 * record), which is exactly why the fallback may state them and the dynamic
 * path may not.
 */
const FALLBACK: FontPairing = {
  heading: { family: 'Inter', category: 'sans-serif', license: 'SIL Open Font License 1.1', url: googleUrl('Inter') },
  body: { family: 'Source Serif 4', category: 'serif', license: 'SIL Open Font License 1.1', url: googleUrl('Source Serif 4') },
  note: ADVISORY_NOTE,
};

interface GoogleFontItem {
  family: string;
  category: string;
}

/** Pick a heading/body pairing from the Google Fonts catalogue. */
export async function fetchFontPairing(deps: {
  fetchImpl: FetchLike;
  apiKey: string;
}): Promise<FontPairing> {
  try {
    const response = await deps.fetchImpl(
      `https://www.googleapis.com/webfonts/v1/webfonts?sort=popularity&key=${encodeURIComponent(deps.apiKey)}`,
    );
    if (!response.ok) return FALLBACK;
    const body = (await response.json()) as { items?: GoogleFontItem[] };
    const items = body.items ?? [];
    // A sans heading paired with a serif body reads as intentional; display
    // faces are excluded because they pair badly with an unknown mark.
    const heading = items.find((f) => f.category === 'sans-serif');
    const body2 = items.find((f) => f.category === 'serif');
    if (!heading || !body2) return FALLBACK;
    return {
      heading: ref(heading.family, heading.category),
      body: ref(body2.family, body2.category),
      note: ADVISORY_NOTE,
    };
  } catch {
    return FALLBACK;
  }
}
