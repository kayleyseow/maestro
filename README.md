# Maestro

A Chrome extension that adds the video controls Instagram's web player is missing:

- **Speed control** — preset playback speeds (0.25x–2x), YouTube-style.
- **Scrubber** — a draggable seek bar / timeline at the bottom of each video.

Scope (v1): feed posts and Reels. Stories are excluded.

Maestro is fully client-side and collects or transmits no data.

## Status

**Phase 3** — speed-control pill, left/right tap zones, and a draggable
scrubber at the bottom of every video. Tap a side zone to skip ±5s (stacks
within ~800ms); press and hold for 2× forward or reverse boost; drag the
scrubber to seek anywhere. An optional frame-preview thumbnail above the
scrubber (gated behind `SHOW_FRAME_PREVIEW`) shows the video at the hovered
position. Promoted reels auto-skip on the Reels feed. IG's overlay chrome
(caption, mute, follow) fades during boost and drag-Maestro. Maestro is
disabled entirely on Stories; on post-detail (`/p/<id>/`) the column UI
stays put.

## Load the unpacked extension

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this folder.
4. Open [instagram.com](https://www.instagram.com), then open DevTools (F12)
   and watch the Console — you'll see `[Maestro] video found` lines as videos
   appear while you scroll.

## Project layout

```
manifest.json     Manifest V3 config
src/content.js    Content script — finds and tracks <video> elements
```
