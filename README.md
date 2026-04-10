# Maestro

Hey friends! (my unpaid beta testers). Maestro is a small Chrome
extension that adds the video controls Instagram's web player has
been missing — speed, scrubbing, skip, and boost. Everything runs
locally in your browser, so none of your data goes anywhere.

**Where it works:** feed posts, Reels, and post-detail pages
(`/p/<id>/`). Stories are intentionally left alone.

## What it does

### With a mouse (or trackpad)

- **Speed pill** in the top-right of every video. Click to pick from
  `0.5×` / `1×` / `1.25×` / `1.5×` / `1.75×` / `2×`.
- **Tap a side margin** to skip ±5 s. Tap quickly a couple of times
  and it stacks (two taps on the right = +10 s).
- **Hold a side margin** for a 2× reverse or forward boost — as long
  as you keep holding.
- **Drag the scrubber** — the thin white seek bar at the bottom of
  every video. Hover for a timestamp. There's an optional frame
  thumbnail too; flip `SHOW_FRAME_PREVIEW = true` in `src/content.js`
  if you want to play with it.
- **Promoted reels skip themselves** on the Reels feed.

While you're boosting or drag-scrubbing, IG's caption / username /
mute / follow chrome fades out of the way so you can actually see
the video.

### With a keyboard

| Key | What it does |
|---|---|
| `J` (tap) | Skip −5 s |
| `J` (hold) | 2× reverse boost while you hold |
| `K` (tap) | Skip +5 s |
| `K` (hold) | 2× forward boost while you hold |
| `Shift+J` / `Shift+K` | Skip ±10 s |
| `U` / `I` | Step speed down / up through the presets |
| `M` | Mute / unmute |
| `R` | Reset speed back to 1× |

Shortcuts always target whichever video is closest to the center of
your screen. They're off while you're typing in a DM, comment, or
search bar, so they won't get in your way.

## How to install it

Maestro isn't on the Chrome Web Store yet, so you'll load it
directly. Should take about a minute:

1. **Grab the code.** Either clone the repo:
   ```
   git clone https://github.com/kayleyseow/maestro.git
   ```
   …or just download a ZIP — click the green **Code** button on
   GitHub, then **Download ZIP**, then unzip it somewhere you'll
   remember.
2. Pop open **`chrome://extensions`** in Chrome (paste that into
   the address bar).
3. Flip **Developer mode** on — toggle in the top-right of the page.
4. Click **Load unpacked** (top-left) and pick the `maestro` folder
   you just grabbed.
5. Pin Maestro so you can see it — click the little puzzle-piece
   icon next to the address bar, then the pin next to Maestro.
6. Open or reload [instagram.com](https://www.instagram.com). The
   speed pill, tap zones, and scrubber should all appear on every
   video.

To double-check it's running, open DevTools (F12) → **Console**.
You'll see lines like `[Maestro] video found` as videos load.

## If something breaks (and thanks for testing!)

Honestly, the more weird stuff you find, the better. The most useful
thing you can send back:

- The **URL** you were on (e.g. `instagram.com/reels/DXyz.../`)
- **What you did** — the key you pressed, or the click / drag
- **What you expected vs. what actually happened**
- *(Bonus)* a screenshot or quick screen recording
- *(Bonus)* any red errors from the DevTools Console

DM me or [open an issue on the GitHub repo](https://github.com/kayleyseow/maestro/issues).
No bug is too small.

## What's in the project

```
manifest.json     Manifest V3 config
src/content.js    The actual extension code lives here
README.md         You're reading it
```
