# Scrub

A Chrome extension that adds the video controls Instagram's web player is missing:

- **Speed control** — preset playback speeds (0.25x–2x), YouTube-style.
- **Scrubber** — a draggable seek bar / timeline at the bottom of each video.

Scope (v1): feed posts and Reels. Stories are excluded.

Scrub is fully client-side and collects or transmits no data.

## Status

**Phase 0** — extension scaffold + video detection. No UI yet.

## Load the unpacked extension

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this folder.
4. Open [instagram.com](https://www.instagram.com), then open DevTools (F12)
   and watch the Console — you'll see `[Scrub] video found` lines as videos
   appear while you scroll.

## Project layout

```
manifest.json     Manifest V3 config
src/content.js    Content script — finds and tracks <video> elements
```
