import { describe, expect, it } from "vitest";
import { extractUrls, isPlaylistUrl, isYoutubeUrl } from "./url";

describe("isYoutubeUrl", () => {
  it("accepts watch, short, and music links", () => {
    expect(isYoutubeUrl("https://www.youtube.com/watch?v=abc123")).toBe(true);
    expect(isYoutubeUrl("https://youtu.be/abc123")).toBe(true);
    expect(isYoutubeUrl("https://www.youtube.com/shorts/abc123")).toBe(true);
    expect(isYoutubeUrl("https://music.youtube.com/watch?v=abc123")).toBe(true);
  });

  it("rejects non-YouTube input", () => {
    expect(isYoutubeUrl("https://vimeo.com/12345")).toBe(false);
    expect(isYoutubeUrl("not a url")).toBe(false);
    expect(isYoutubeUrl("")).toBe(false);
  });
});

describe("isPlaylistUrl", () => {
  it("accepts a dedicated playlist page", () => {
    expect(isPlaylistUrl("https://www.youtube.com/playlist?list=PLxyz")).toBe(true);
    expect(isPlaylistUrl("https://music.youtube.com/playlist?list=PLxyz")).toBe(true);
  });

  it("does not treat a normal watch link with &list= as a playlist", () => {
    expect(isPlaylistUrl("https://www.youtube.com/watch?v=abc123&list=PLxyz")).toBe(false);
  });
});

describe("extractUrls", () => {
  it("splits multiple links on whitespace and newlines", () => {
    const text = `
      https://www.youtube.com/watch?v=aaa111
      https://youtu.be/bbb222
    `;
    expect(extractUrls(text)).toEqual([
      "https://www.youtube.com/watch?v=aaa111",
      "https://youtu.be/bbb222",
    ]);
  });

  it("splits on commas too", () => {
    const text = "https://youtu.be/aaa111, https://youtu.be/bbb222";
    expect(extractUrls(text)).toEqual([
      "https://youtu.be/aaa111",
      "https://youtu.be/bbb222",
    ]);
  });

  it("dedupes repeated links", () => {
    const text = "https://youtu.be/aaa111 https://youtu.be/aaa111";
    expect(extractUrls(text)).toEqual(["https://youtu.be/aaa111"]);
  });

  it("ignores non-YouTube noise mixed in", () => {
    const text = "check this out https://youtu.be/aaa111 not-a-link https://vimeo.com/1";
    expect(extractUrls(text)).toEqual(["https://youtu.be/aaa111"]);
  });

  it("returns an empty array for text with no links", () => {
    expect(extractUrls("nothing here")).toEqual([]);
  });

  it("keeps a pure playlist link even though it has no v= param", () => {
    const text = "https://www.youtube.com/playlist?list=PLxyz";
    expect(extractUrls(text)).toEqual(["https://www.youtube.com/playlist?list=PLxyz"]);
  });

  it("handles a mix of video and playlist links", () => {
    const text = [
      "https://www.youtube.com/watch?v=aaa111",
      "https://www.youtube.com/playlist?list=PLxyz",
    ].join("\n");
    expect(extractUrls(text)).toEqual([
      "https://www.youtube.com/watch?v=aaa111",
      "https://www.youtube.com/playlist?list=PLxyz",
    ]);
  });

  it("strips trailing punctuation stuck to a pasted link", () => {
    expect(extractUrls("check this out (https://youtu.be/abc123)!")).toEqual([
      "https://youtu.be/abc123",
    ]);
    expect(extractUrls('"https://youtu.be/abc123."')).toEqual(["https://youtu.be/abc123"]);
  });
});
