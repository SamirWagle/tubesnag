export const YOUTUBE_RE =
  /(https?:\/\/)?(www\.|m\.|music\.)?(youtube\.com\/(watch\?.*v=|shorts\/)|youtu\.be\/)/i;

// A dedicated /playlist page, not just any watch URL that happens to carry
// `&list=` (which is the common case when a video is opened from inside a
// playlist but the user just means "this one video").
const PLAYLIST_RE = /(www\.|music\.)?youtube\.com\/playlist\?.*list=/i;

export function isYoutubeUrl(url: string): boolean {
  return YOUTUBE_RE.test(url);
}

export function isPlaylistUrl(url: string): boolean {
  return PLAYLIST_RE.test(url);
}

// Wrapping punctuation that's almost always sentence formatting, not part of
// the URL: an opening/closing paren/bracket/quote, or terminal punctuation
// like `.`, `!`, `?`.
const LEADING_PUNCTUATION_RE = /^[([{<"'`]+/;
const TRAILING_PUNCTUATION_RE = /[)\]}>.,!?;:"'`]+$/;

function stripWrappingPunctuation(url: string): string {
  let prev;
  do {
    prev = url;
    url = url.replace(LEADING_PUNCTUATION_RE, "").replace(TRAILING_PUNCTUATION_RE, "");
  } while (url !== prev);
  return url;
}

/** Splits pasted/copied text on whitespace and commas and keeps only valid, deduped YouTube video/playlist links. */
export function extractUrls(text: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of text.split(/[\s,]+/)) {
    const url = stripWrappingPunctuation(raw.trim());
    if (url && (isYoutubeUrl(url) || isPlaylistUrl(url)) && !seen.has(url)) {
      seen.add(url);
      result.push(url);
    }
  }
  return result;
}
