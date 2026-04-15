// Maestro — content script
// Phase 1: detect <video> elements and mount a speed-control pill onto each.
// Per-video scope — every newly mounted video starts at 1×.
//
// The pill is mounted as a direct child of <body> with position: fixed,
// anchored to the video's getBoundingClientRect(). This sidesteps IG's
// per-post click-catchers (notably on Reels) and stacking contexts.

(() => {
  "use strict";

  const TRACKED_ATTR = "data-maestro-tracked";
  const SPEED_PRESETS = [0.5, 1, 1.25, 1.5, 1.75, 2];

  // Single global debug toggle. Flip to true to enable:
  //   - Every console.* log Maestro emits ([Maestro] track/visibility/boost,
  //     [Maestro debug] pointer events, etc.).
  //   - Red/blue tint + dashed outlines on the left/right tap zones.
  //   - Extra pointerdown logger that reports what element each press hits.
  // dlog is a direct binding to console.debug when DEBUG is on, and a
  // no-op otherwise — call sites pay nothing when shipping.
  const DEBUG = true;
  const dlog = DEBUG ? console.debug.bind(console) : () => {};

  // Reels only — other surfaces lack clean per-item "next" navigation.
  const AUTO_SKIP_PROMOTED = true;

  // Auto-advance (Reels) — when ON, scroll to the next reel as soon as the
  // current one finishes a single play, instead of letting IG loop it forever.
  // The setting is global across every reel and persisted in localStorage so
  // the choice survives reloads (off by default, per product decision). A small
  // listener set keeps every mounted toggle's icon in sync when the value flips
  // on any one reel.
  const AUTO_ADVANCE_KEY = "maestro:autoAdvance";
  // How far before the end (seconds) to fire the skip. timeupdate fires
  // ~4×/sec, so a 0.35s lead reliably catches the end before a looping reel
  // wraps currentTime back to 0 (loop = true means `ended` never fires).
  const AUTO_ADVANCE_LEAD_S = 0.35;
  let autoAdvanceEnabled = false;
  try {
    autoAdvanceEnabled = localStorage.getItem(AUTO_ADVANCE_KEY) === "1";
  } catch (e) {
    // localStorage can throw in locked-down contexts; default to off.
  }
  const autoAdvanceListeners = new Set();
  function setAutoAdvance(on) {
    autoAdvanceEnabled = !!on;
    try {
      localStorage.setItem(AUTO_ADVANCE_KEY, autoAdvanceEnabled ? "1" : "0");
    } catch (e) {
      // Persisting failed (private mode / blocked storage). The in-memory value
      // still drives this session; we just won't remember it next load.
    }
    autoAdvanceListeners.forEach((fn) => fn(autoAdvanceEnabled));
    dlog("[Maestro] auto-advance", autoAdvanceEnabled ? "ON" : "OFF");
  }

  // User-tunable scrubber preferences (future settings UI will toggle these).
  const SHOW_FRAME_PREVIEW = false;
  // Forced on internally whenever SHOW_FRAME_PREVIEW is on.
  const SHOW_TOTAL_TIME = false;

  // Delay between detecting a promoted reel and firing the skip — kept tiny so
  // the ad is gone almost instantly. The small random jitter just avoids a
  // perfectly robotic cadence. Stays well under ~500ms: past that IG sometimes
  // auto-advances on its own and our skip then fires into a different DOM.
  const PROMOTED_SKIP_DELAY_MIN_MS = 0;
  const PROMOTED_SKIP_DELAY_MAX_MS = 50;

  // Scope: feed posts, Explore, and Reels only — Stories are out per
  // product scope (see README). IG's Stories URLs all live under /stories/.
  function isStoriesPage() {
    return /^\/stories(\/|$)/.test(location.pathname);
  }

  // Post-detail / permalink pages: /p/<id>/ and /<username>/p/<id>/. The
  // layout there is column-based — IG's chrome (profile header, action rail,
  // caption, comments) sits ALONGSIDE the video, not overlaying it. We still
  // want skip/boost to work, but we don't want to fade out those sections on
  // a skip the way we do on Home/Reels where chrome overlays the video.
  function isPostDetailPage() {
    return /(^|\/)p\/[^/]+/.test(location.pathname);
  }

  // Reels feed URLs (/reels/<id>/, /reels/) — the surface where the
  // "Navigate to next Reel" button exists. Single-reel permalinks like
  // /<user>/reel/<id>/ don't have that button, so auto-skip is no-op there.
  function isReelsFeedPage() {
    return /^\/reels(\/|$)/.test(location.pathname);
  }

  // Detect whether the reel containing `video` is promoted.
  //
  // Two signals, either one is sufficient:
  //   1. An <a> with href containing "/ads/ig_redirect/" — IG's tracked
  //      redirect endpoint for promoted content. Server-side route, very
  //      stable. (URL path is IG's, not ours.)
  //   2. A span whose textContent is exactly "Ad" — IG's disclosure badge
  //      string. Always present on promoted Reels. (Text is IG's, not ours.)
  //
  // We walk up from the video element to find each ancestor level. At each
  // level we query for the signals scoped to that ancestor. If the ancestor
  // contains more than one <video>, we've walked past this reel's container
  // (into siblings) and we bail to avoid false positives from neighbouring
  // promoted reels in the carousel.
  function isPromotedReel(video) {
    let cur = video.parentElement;
    let hops = 0;
    while (cur && cur !== document.body && hops < 25) {
      if (cur.querySelectorAll("video").length > 1) return false;
      if (cur.querySelector('a[href*="/ads/ig_redirect/"]')) return true;
      const spans = cur.querySelectorAll("span");
      for (const s of spans) {
        if (s.children.length === 0 && s.textContent && s.textContent.trim() === "Ad") {
          return true;
        }
      }
      cur = cur.parentElement;
      hops++;
    }
    return false;
  }

  // Walk up from `video` to the outermost ancestor that's still "this reel
  // only" — i.e., doesn't contain any other <video> elements. That ancestor
  // is the per-reel item container (a sibling of other reels in the feed).
  // Used by hidePromotedReel to know which subtree to black out.
  function findReelItemContainer(video) {
    let cur = video.parentElement;
    let last = cur;
    while (cur && cur !== document.body) {
      if (cur.querySelectorAll("video").length > 1) break;
      last = cur;
      cur = cur.parentElement;
    }
    return last;
  }

  // Make the promoted reel's container visually invisible AND silence the
  // video, while preserving its layout box. `visibility: hidden` keeps the
  // element's height in flow so scroll-snap math (skipReel Strategy 2)
  // still computes correct viewport offsets — using `display: none` would
  // collapse the height and shift everything below it, potentially
  // confusing IG's carousel.
  //
  // muted + volume:0 belt-and-suspenders: setting both means even if IG
  // unmutes via DOM property or volume change as part of its playback
  // logic, the other one keeps the audio at 0. Practically: the user gets
  // no audio at all during the brief delay before scroll.
  //
  // Returns the container it blanked (or null), so the caller can restore its
  // visibility when the reel scrolls away or IG reuses this pooled <video> for
  // fresh content — otherwise a recycled non-ad reel would be left blank.
  function hidePromotedReel(video) {
    try {
      video.muted = true;
      video.volume = 0;
    } catch (e) {
      // muted/volume can throw in rare permissions-restricted contexts; ignore.
    }
    const container = findReelItemContainer(video);
    if (container && container !== document.body) {
      container.style.visibility = "hidden";
      dlog("[Maestro] promoted-skip: blanked + muted promoted reel container", container);
      return container;
    }
    return null;
  }

  // Direction the user is currently travelling through the Reels feed, so a
  // promoted-reel skip can continue *with* the scroll instead of always going
  // forward. The old always-forward skip trapped an upward scroll on an ad:
  // reaching the ad going up triggered a forward skip that dropped the user
  // right back below it, so they could never get past the ad upward. We read
  // the snap container's scrollTop on real scroll events and remember the last
  // non-trivial direction; defaults to "down" (forward) for first load and any
  // programmatic activation with no prior scroll.
  let lastReelScrollDir = "down";
  let lastReelScrollEl = null;
  let lastReelScrollTop = 0;
  document.addEventListener("scroll", (e) => {
    const el = e.target;
    if (!el || el.nodeType !== 1) return;               // ignore document/window scrolls
    if (el.scrollHeight <= el.clientHeight + 4) return; // not the vertical snap container
    // Only compare deltas within the same element — switching containers would
    // diff unrelated scrollTops and report a bogus direction.
    if (el === lastReelScrollEl) {
      const dy = el.scrollTop - lastReelScrollTop;
      if (Math.abs(dy) > 2) lastReelScrollDir = dy > 0 ? "down" : "up";
    }
    lastReelScrollEl = el;
    lastReelScrollTop = el.scrollTop;
  }, true);

  // Advance the Reels feed one item in `dir` ("down" = forward/next reel,
  // "up" = back/previous reel). Tries three strategies in order — button
  // click, scroll-snap by viewport, Arrow keydown — because the prev/next
  // button is only mounted while the user is hovering the Reels area, so
  // Strategy 1 silently fails when auto-skip fires headlessly. Skipping in the
  // travel direction means an ad reached while scrolling up is skipped *up*
  // (past it) rather than bouncing the user back down onto the reel below.
  function skipReel(dir) {
    const forward = dir !== "up";
    // Strategy 1: click IG's prev/next-reel button. Works when the user's
    // cursor is over the Reels area (IG mounts the button on hover).
    const selectors = forward
      ? ['[aria-label="Navigate to next Reel"]', '[aria-label*="next reel" i]', '[aria-label*="next" i][role="button"]']
      : ['[aria-label="Navigate to previous Reel"]', '[aria-label*="previous reel" i]', '[aria-label*="previous" i][role="button"]'];
    for (const sel of selectors) {
      const btn = document.querySelector(sel);
      if (btn) {
        dlog("[Maestro] promoted-skip: clicking", forward ? "next" : "previous", "reel button", btn);
        btn.click();
        return;
      }
    }

    // Strategy 2: scroll the Reels carousel by ±one viewport. IG Reels uses
    // CSS scroll-snap, so scrolling by ±clientHeight snaps to the adjacent
    // item. This works regardless of whether the user is hovering.
    const v = document.querySelector('video[data-maestro-tracked]');
    if (v) {
      let cur = v.parentElement;
      while (cur && cur !== document.documentElement) {
        if (cur.scrollHeight > cur.clientHeight + 4) {
          const style = getComputedStyle(cur);
          if (style.overflowY === "auto" || style.overflowY === "scroll") {
            const dy = forward ? cur.clientHeight : -cur.clientHeight;
            dlog("[Maestro] promoted-skip: scrolling reels container by", dy, "px", cur);
            cur.scrollBy(0, dy);
            return;
          }
        }
        cur = cur.parentElement;
      }
    }

    // Strategy 3: synthesize an Arrow keydown. IG binds arrow-key navigation
    // on the Reels page. Untrusted event but worth a shot — last resort if no
    // scroll container and no button.
    const key = forward ? "ArrowDown" : "ArrowUp";
    const keyCode = forward ? 40 : 38;
    dlog("[Maestro] promoted-skip: dispatching", key, "keydown");
    document.dispatchEvent(new KeyboardEvent("keydown", {
      key,
      code: key,
      keyCode,
      which: keyCode,
      bubbles: true,
      cancelable: true,
    }));
  }

  /** Live set of <video> elements Maestro currently knows about. */
  const videos = new Set();

  // Per-video UI handle so untrack() can fully tear it down.
  // WeakMap lets detached <video>s be GC'd if untrack ever misses one.
  const uiByVideo = new WeakMap();

  // Instagram now ships its own volume control, so Maestro no longer mounts
  // one — but we still have to keep our hands off it. IG wraps the whole
  // control (the mute button AND the slider that slides up from it) in a
  // single [role="slider"][aria-label="Adjust volume"] element; the mute
  // button is a descendant [role="button"] holding <svg aria-label="Audio
  // is …">, and the slide-up track/fill/thumb are its other descendants.
  //
  // That control can sit inside our left/right tap-zone (e.g. pinned against
  // the left margin), where mountSpeedUI's window-capture zone handler would
  // otherwise steal the hover/drag and fire a skip/boost. isPressOnIGVolumeControl
  // walks the live hit-stack under the press: if any element resolves into
  // IG's volume control we step aside. Testing the live stack makes it
  // self-correcting — when the slider is collapsed only the button is there;
  // when it's revealed the slid-up track is too. Keying off the aria-label
  // matches how we detect the rest of IG's chrome (the x*-classes are
  // obfuscated and unstable).
  const IG_VOLUME_SELECTOR = '[role="slider"][aria-label="Adjust volume"]';
  function isPressOnIGVolumeControl(x, y) {
    for (const el of document.elementsFromPoint(x, y)) {
      if (el.closest && el.closest(IG_VOLUME_SELECTOR)) return true;
    }
    return false;
  }

  // Read the CSS transition IG uses to expand its volume panel, so the speed
  // pill can open at the same pace. Walk the volume control + descendants for
  // the first element carrying a non-zero transition-duration (the element
  // that actually animates the slide-open) and return its longest-running
  // duration plus the matching timing function. Null if IG's control isn't
  // mounted or animates via JS rather than a CSS transition — caller then
  // keeps the pill's CSS-default timing. Splitting on top-level commas only
  // (the negative-lookahead) keeps cubic-bezier(...) args intact.
  function getIGVolumeTransition() {
    const control = document.querySelector(IG_VOLUME_SELECTOR);
    if (!control) return null;
    for (const el of [control, ...control.querySelectorAll("*")]) {
      const cs = getComputedStyle(el);
      const durs = cs.transitionDuration.split(",").map((s) => parseFloat(s) || 0);
      const maxDur = Math.max(0, ...durs);
      if (maxDur > 0) {
        const timings = cs.transitionTimingFunction.split(/,(?![^(]*\))/);
        const i = durs.indexOf(maxDur);
        return { duration: `${maxDur}s`, timing: (timings[i] || timings[0] || "ease").trim() };
      }
    }
    return null;
  }

  // Find Instagram's own mute button for `video`, so the M shortcut can CLICK
  // it (letting IG flip its own mute state AND update its speaker glyph) rather
  // than poke video.muted directly — a direct write mutes the audio but leaves
  // IG's icon stale. The button is the [role="button"] wrapping
  // <svg aria-label="Audio is muted|playing"> (the descendant of IG's
  // [aria-label="Adjust volume"] control). Feed posts scope it to the video's
  // <article>; Reels keep several mounted at once, so we pick the button whose
  // center sits inside the target video's rect (the active reel).
  function findIGMuteButton(video) {
    const scope = video.closest("article") || document;
    const buttons = [];
    for (const svg of scope.querySelectorAll("svg[aria-label]")) {
      const label = (svg.getAttribute("aria-label") || "").toLowerCase();
      if (!label.startsWith("audio is ")) continue; // "Audio is muted/playing"
      const btn = svg.closest('[role="button"]');
      if (btn) buttons.push(btn);
    }
    if (buttons.length <= 1) return buttons[0] || null;
    const vr = video.getBoundingClientRect();
    const vcx = vr.left + vr.width / 2, vcy = vr.top + vr.height / 2;
    let best = null, bestDist = Infinity;
    for (const btn of buttons) {
      const r = btn.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      if (cx < vr.left || cx > vr.right || cy < vr.top || cy > vr.bottom) continue;
      const d = (cx - vcx) ** 2 + (cy - vcy) ** 2;
      if (d < bestDist) { bestDist = d; best = btn; }
    }
    return best || buttons[0];
  }

  // The action-rail icons we know about, by aria-label. Used to locate the Like
  // anchor and to measure the rail's natural icon-to-icon spacing so our toggle
  // drops in at the same rhythm. ("Unlike" is the liked state of the heart.)
  const RAIL_ICON_LABELS = new Set([
    "Like", "Unlike", "Comment", "Repost", "Share", "Save", "More",
  ]);

  // Collect this reel's action-rail icons (the right-hand Like/Comment/… <svg>s)
  // as { label, svg, cx, cy } sorted top→bottom. IG keeps several reels' rails
  // mounted at once (virtualized pool), so we scope to the rail whose icons fall
  // within this video's vertical span. Horizontally we DON'T require the icons
  // to be inside the video: on desktop web the rail sits in the gutter to the
  // RIGHT of the video, only overlaying it on narrow/mobile layouts — so we
  // accept anything from the video's left edge out to a gutter's reach past its
  // right edge. Keyed off aria-label, not IG's obfuscated classes.
  const RAIL_GUTTER_PX = 200;
  function getReelRailIcons(video) {
    const vr = video.getBoundingClientRect();
    const icons = [];
    for (const svg of document.querySelectorAll("svg[aria-label]")) {
      if (!RAIL_ICON_LABELS.has(svg.getAttribute("aria-label"))) continue;
      const r = svg.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      if (cy < vr.top || cy > vr.bottom) continue;             // wrong reel
      if (cx < vr.left || cx > vr.right + RAIL_GUTTER_PX) continue; // not this rail
      icons.push({ label: svg.getAttribute("aria-label"), svg, cx, cy });
    }
    icons.sort((a, b) => a.cy - b.cy);
    return icons;
  }

  // The rail's icon-to-icon vertical pitch (center-to-center), from the median
  // of consecutive gaps — robust to one odd spacing. Null if we can't measure
  // (fewer than two icons); caller falls back to a sane default.
  function railIconPitch(icons) {
    if (icons.length < 2) return null;
    const gaps = [];
    for (let i = 1; i < icons.length; i++) gaps.push(icons[i].cy - icons[i - 1].cy);
    gaps.sort((a, b) => a - b);
    return gaps[Math.floor(gaps.length / 2)];
  }

  // Read the font IG uses for the action-rail label under the Like heart — the
  // "Likes" word, or a count like "2,424" — so our "auto" label matches its
  // family/size/weight exactly rather than an approximation. From the icon's
  // <svg> we climb a few ancestors (the label is ~6 levels up, in a sibling
  // subtree of the icon button) and take the first short `span[dir="auto"]`.
  //
  // Targeting that OUTER label span is deliberate: IG wraps a *numeric* count in
  // an extra inner <span class="html-span"> that adds bold weight, while a word
  // label like "Likes" sits directly in the outer span. Reading the outer
  // dir="auto" span gives the label-level weight ("Likes" style) consistently in
  // both cases, instead of the heavier number styling. We copy the *computed*
  // font (resolves inheritance → rendered values). dir="auto" is a semantic hook
  // (bidi), far more stable than IG's obfuscated x-classes. Returns null when no
  // label is shown; the caller then keeps the CSS default.
  function getIGRailLabelFont(fromEl) {
    let scope = fromEl;
    for (let i = 0; i < 7 && scope; i++) {
      for (const span of scope.querySelectorAll('span[dir="auto"]')) {
        const t = (span.textContent || "").trim();
        if (!t || t.length > 12) continue;                     // a label, not a caption
        const cs = getComputedStyle(span);
        return {
          fontFamily: cs.fontFamily,
          fontSize: cs.fontSize,
          fontWeight: cs.fontWeight,
          letterSpacing: cs.letterSpacing,
          lineHeight: cs.lineHeight,
        };
      }
      scope = scope.parentElement;
    }
    return null;
  }

  // Mimic the subtle "grow on hover" of IG's rail icons. The TIMING (duration +
  // easing) is read live from a real rail button's computed transition — always
  // accessible, and the part that makes the motion feel native. The SCALE amount
  // we pull from IG's own :hover rule when its stylesheet is same-origin; some IG
  // CSS is served cross-origin (opaque to script), so we fall back to a subtle
  // default there. Both are cached — identical across reels, and the stylesheet
  // scan is a one-time cost.
  const IG_HOVER_DEFAULT_SCALE = 1.06;
  let igHoverScale; // undefined = unscanned; null = scanned, none found; number
  function scanIGHoverScale(buttonEl) {
    if (igHoverScale !== undefined) return igHoverScale;
    igHoverScale = null;
    const wanted = new Set(
      (buttonEl.className || "").split(/\s+/).filter(Boolean).map((t) => `.${t}:hover`)
    );
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch (e) { continue; } // cross-origin → opaque
      if (!rules) continue;
      for (const rule of rules) {
        if (!rule.style || !wanted.has(rule.selectorText)) continue;
        const m = (rule.style.transform || "").match(/scale[XY]?\(\s*([\d.]+)/i);
        const s = m && parseFloat(m[1]);
        if (s && s > 1 && s < 1.5) { igHoverScale = s; return s; }
      }
    }
    return igHoverScale;
  }
  function getIGRailHover(buttonEl) {
    const cs = getComputedStyle(buttonEl);
    const props = cs.transitionProperty.split(",").map((s) => s.trim());
    const durs = cs.transitionDuration.split(",").map((s) => s.trim());
    const times = cs.transitionTimingFunction.split(/,(?![^(]*\))/).map((s) => s.trim());
    let i = props.indexOf("transform");
    if (i < 0) i = props.indexOf("all");
    if (i < 0) i = 0;
    let duration = durs[i] || durs[0] || "0s";
    let timing = times[i] || times[0] || "ease";
    // IG doesn't transition this element → use a natural default so the grow
    // still animates rather than snapping.
    if (!duration || duration === "0s") { duration = "200ms"; timing = "ease"; }
    return { scale: scanIGHoverScale(buttonEl) || IG_HOVER_DEFAULT_SCALE, duration, timing };
  }

  // True for any CSS color that paints nothing — "transparent" or an
  // rgba/hsla whose alpha channel is 0. Used to skip past the mute button's
  // own (usually transparent) box to the descendant that actually paints the
  // dark circle.
  function isTransparentColor(c) {
    if (!c || c === "transparent") return true;
    const m = c.match(/^rgba?\(([^)]+)\)/i) || c.match(/^hsla?\(([^)]+)\)/i);
    if (!m) return false;
    const parts = m[1].split(/[,\/]/).map((s) => parseFloat(s));
    return parts.length >= 4 && parts[3] === 0;
  }

  // IG paints the audio toggle's dark circle on the button itself OR a
  // descendant (the [role="button"] wrapper is often a transparent box).
  // Walk button + descendants and return the first element carrying a
  // non-transparent background, so we can mirror its rendered size + color
  // onto our speed pill. Null if nothing paints (icon-only button).
  function muteButtonBackdrop(btn) {
    const els = [btn, ...btn.querySelectorAll("*")];
    for (const el of els) {
      const cs = getComputedStyle(el);
      if (!isTransparentColor(cs.backgroundColor)) {
        return { el, bg: cs.backgroundColor };
      }
    }
    return null;
  }

  // Injected page-level stylesheet — used to hide IG's chrome (account info,
  // follow button, caption, mute) during a 2× boost. Lives outside our shadow
  // DOM because the elements we tag belong to IG, not us.
  const boostStyleTag = document.createElement("style");
  boostStyleTag.textContent = `
    .maestro-boost-hidden {
      opacity: 0 !important;
      pointer-events: none !important;
      transition: opacity 150ms ease !important;
    }
  `;
  document.head.appendChild(boostStyleTag);

  function formatRate(r) {
    return `${r}×`;
  }

  function mountSpeedUI(video) {
    const host = document.createElement("div");
    host.className = "maestro-speed-host";
    // Sized + positioned to match the video; the pill is absolute inside.
    // pointer-events: none on the host so clicks pass through to IG except
    // where the pill itself sets pointer-events: auto.
    host.style.cssText = [
      "position:fixed",
      "z-index:2147483647", // max int32 — beat any IG stacking context
      "pointer-events:none",
      "margin:0",
      "padding:0",
    ].join(";");

    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .pill {
          position: absolute;
          top: 8px;
          right: 8px;
          /* Defaults preserve the original look; syncPillToMuteButton()
             overrides these to mirror IG's live audio toggle. */
          --m-size: 36px;
          --m-bg: rgba(0, 0, 0, 0.5);
          --m-radius: 18px;
          width: var(--m-size);
          height: var(--m-size);
          font: 400 14px/1 "Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif;
          color: #fff;
          background: var(--m-bg);
          border-radius: var(--m-radius);
          cursor: pointer;
          pointer-events: auto;
          user-select: none;
          overflow: hidden;
          transition: width 220ms cubic-bezier(0.4, 0, 0.2, 1);
        }
        /* Six preset circles (each --m-size wide) + 5×2px gaps + 8px row padding. */
        .pill.open { width: calc(var(--m-size) * 6 + 18px); }
        .pill .display {
          position: absolute;
          right: 0;
          top: 0;
          width: var(--m-size);
          height: var(--m-size);
          display: flex;
          align-items: center;
          justify-content: center;
          /* Match the open row's presets exactly (11px / weight 400 / full-
             size ×) so the number doesn't resize when the menu opens/closes. */
          font-size: 11px;
        }
        .pill.open .display { opacity: 0; pointer-events: none; }
        /* 4-char rates (1.25 / 1.75) — one point smaller so they clear the
           circle edge. Applied to both states (resting + open row) so a given
           rate is the same size whether the menu is open or closed. */
        .pill.shrink .display { font-size: 10px; }
        .pill .display .x {
          font-size: 1em;
          opacity: 0.85;
          margin-left: -1px;
        }
        .pill .row {
          position: absolute;
          right: 0;
          top: 0;
          height: var(--m-size);
          display: flex;
          align-items: center;
          gap: 2px;
          padding: 0 4px;
          opacity: 0;
          pointer-events: none;
          transition: opacity 140ms ease 80ms;
          font-size: 11px;
        }
        .pill.open .row { opacity: 1; pointer-events: auto; }
        .pill .row button {
          border: 0;
          background: transparent;
          color: #fff;
          font: inherit;
          font-weight: 400;
          width: var(--m-size);
          height: var(--m-size);
          flex: 0 0 auto;
          padding: 0;
          border-radius: 50%;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          white-space: nowrap;
          transition: background-color 120ms ease;
        }
        /* Hover preview — light-grey fill so the speed under the cursor reads
           as "about to be selected". Same fill as the active (current) speed. */
        .pill .row button.narrow { font-size: 10px; }
        .pill .row button:hover { background: rgba(255, 255, 255, 0.18); }
        .pill .row button.active { background: rgba(255, 255, 255, 0.18); }
        .pill .row button.preview { background: rgba(255, 255, 255, 0.32); }
        .zone {
          position: absolute;
          /* Coarse safe bands at top and bottom. The per-press hit-test in
             onZoneDocDown is what actually keeps IG's icon buttons clickable
             — these bands just bias the zone away from the densest chrome.
             Bottom = 30px so the zone reaches down to just above the small
             corner icons (Tags / Audio-is-playing on Home, ~12px svgs). */
          top: 60px;
          bottom: 30px;
          width: 25%;
          /* Zones are visual-only — hit-testing happens per-press at the
             document level so we never eat clicks meant for IG's action rail
             or block IG's vertical swipe-to-next-reel. */
          pointer-events: none;
        }
        .zone.left { left: 0; }
        .zone.right { right: 0; }
        .zone.debug.left { background-color: rgba(255, 0, 0, 0.12); outline: 1px dashed rgba(255, 0, 0, 0.6); }
        .zone.debug.right { background-color: rgba(0, 120, 255, 0.12); outline: 1px dashed rgba(0, 120, 255, 0.6); }
        .pill.hidden { opacity: 0; pointer-events: none; transition: opacity 150ms ease; }
        .boost-badge {
          position: absolute;
          bottom: 16px;
          left: 50%;
          transform: translateX(-50%);
          font: 600 14px/1 "Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif;
          color: #fff;
          background: rgba(0, 0, 0, 0.6);
          padding: 8px 14px;
          border-radius: 18px;
          pointer-events: none;
          opacity: 0;
          transition: opacity 120ms ease;
          white-space: nowrap;
        }
        .boost-badge.on { opacity: 1; }
        /* Scrubber — mobile-IG-style thin bar at the video's bottom edge.
           14px hit zone for the cursor; inside, a 2px track that thickens
           to 5px on hover/drag. Thumb + time label appear on hover/drag. */
        .scrubber {
          position: absolute;
          left: 0;
          right: 0;
          bottom: 0;
          height: 14px;
          pointer-events: auto;
          user-select: none;
          touch-action: none;
        }
        .scrubber-track {
          position: absolute;
          left: 0;
          right: 0;
          bottom: 0;
          height: 2px;
          background: rgba(255, 255, 255, 0.3);
          transition: height 150ms ease;
          overflow: hidden;
        }
        .scrubber:hover .scrubber-track,
        .scrubber.dragging .scrubber-track,
        .scrubber.active .scrubber-track { height: 5px; }
        .scrubber-fill {
          height: 100%;
          background: rgba(255, 255, 255, 0.95);
          width: 0%;
        }
        .scrubber-thumb {
          position: absolute;
          bottom: 0;
          left: 0;
          width: 12px;
          height: 12px;
          margin-bottom: -3px;
          border-radius: 50%;
          background: #fff;
          transform: translateX(-50%);
          opacity: 0;
          transition: opacity 150ms ease;
          pointer-events: none;
        }
        .scrubber:hover .scrubber-thumb,
        .scrubber.dragging .scrubber-thumb,
        .scrubber.active .scrubber-thumb { opacity: 1; }
        .scrubber-label {
          position: absolute;
          bottom: 16px;
          left: 0;
          padding: 3px 7px;
          background: rgba(0, 0, 0, 0.72);
          color: #fff;
          /* IG's web font stack so the timestamp matches their mute/audio badge. */
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Helvetica, Arial, sans-serif;
          font-size: 12px;
          font-weight: 500;
          line-height: 1.25;
          letter-spacing: 0;
          font-variant-numeric: tabular-nums;
          border-radius: 4px;
          white-space: nowrap;
          pointer-events: none;
          opacity: 0;
          transform: translateX(-50%);
          transition: opacity 120ms ease;
        }
        .scrubber:hover .scrubber-label,
        .scrubber.dragging .scrubber-label { opacity: 1; }
        .scrubber-preview-canvas {
          position: absolute;
          /* Sits above the timestamp label (~22px tall + 6px gap above the 16px label-bottom). */
          bottom: 44px;
          left: 0;
          /* Size driven by canvas width/height attrs (set from JS once video aspect is known). */
          border-radius: 8px;
          background: #000;
          display: none;
          opacity: 0;
          transform: translateX(-50%);
          pointer-events: none;
          transition: opacity 120ms ease;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.45);
        }
        .scrubber.with-preview .scrubber-preview-canvas { display: block; }
        .scrubber.with-preview:hover .scrubber-preview-canvas,
        .scrubber.with-preview.dragging .scrubber-preview-canvas { opacity: 1; }
        .scrubber.hidden { opacity: 0; pointer-events: none; transition: opacity 150ms ease; }
        .scrubber.disabled { display: none; }
        /* Auto-advance toggle — Reels only. A bare white play glyph + "auto"
           label, styled to sit in IG's right-hand action rail just above the
           Like button: drop-shadow for legibility over video, no chrome of its
           own so it reads as one of IG's native icons. Positioned each frame by
           updateAutoTogglePosition; hidden whenever no Like button is located. */
        .auto-toggle {
          position: absolute;
          left: 0;
          top: 0;
          display: none;
          flex-direction: column;
          align-items: center;
          gap: 3px;
          /* Positioned by JS so the play glyph's center lands one rail-pitch
             above IG's Like icon; translateX centers the column on that icon. */
          transform: translateX(-50%);
          pointer-events: auto;
          cursor: pointer;
          user-select: none;
          -webkit-user-select: none;
          filter: drop-shadow(0 1px 3px rgba(0, 0, 0, 0.55));
          opacity: 0.92;
          transition: opacity 120ms ease;
        }
        .auto-toggle:hover { opacity: 1; }
        /* Grow on hover, mimicking IG's rail icons. Scale amount + timing are
           synced live from a real IG rail button (maybeSyncAutoHover); the var
           default keeps it sane until then. Like IG: hovering the icon grows
           BOTH the glyph and the "auto" label (sibling combinator); hovering the
           label grows only the label. */
        .auto-icon:hover,
        .auto-icon:hover ~ .auto-label,
        .auto-label:hover { transform: scale(var(--m-hover-scale, 1.06)); }
        /* Press feedback lives on the glyph only — the "auto" label must not
           react to a click (no scale/squish). Higher specificity than the hover
           rule, so a press wins over hover on the icon. */
        .auto-toggle:active .auto-icon { transform: scale(0.9); }
        /* A touch larger than IG's 24px rail glyphs so the filled play triangle
           reads at the same visual height as the Share/send icon (its glyph
           fills more of its box than ours does). Fixed height so the icon's
           center offset is predictable for the pitch math below. */
        .auto-toggle .auto-icon { height: 28px; display: flex; align-items: center; transition: transform 120ms ease; }
        .auto-toggle svg { width: 28px; height: 28px; display: block; }
        .auto-toggle .tri {
          /* Transparent-WHITE (not 'none') so the fill can ANIMATE its alpha
             0→1 on toggle — R=G=B stay 255 throughout, so it fades in cleanly
             with no gray flash. Hollow look = alpha-0 fill + white stroke. */
          fill: rgba(255, 255, 255, 0);
          stroke: #fff;
          stroke-width: 2.2;
          stroke-linejoin: round;
          transition: fill 200ms ease;
        }
        /* ON = filled glyph; OFF = hollow outline — mirrors how IG's own rail
           icons fill in on activation (e.g. the heart). */
        .auto-toggle.on .tri { fill: rgba(255, 255, 255, 1); }
        /* Spring-pop the glyph when it flips ON (off→on only; see popIcon). The
           overshoot + slight undershoot give the bounce. It briefly overrides
           the hover/press transforms while running, then reverts (the transform
           transition smooths the hand-off). */
        @keyframes maestro-pop {
          0%   { transform: scale(1); }
          45%  { transform: scale(1.25); }
          72%  { transform: scale(0.95); }
          100% { transform: scale(1); }
        }
        .auto-toggle .auto-icon.pop { animation: maestro-pop 320ms ease-out; }
        .auto-toggle .auto-label {
          font: 600 11px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Helvetica, Arial, sans-serif;
          color: #fff;
          letter-spacing: 0.2px;
          transition: transform 120ms ease;
        }
        /* Dim the label a touch when off so the active state reads brighter. */
        .auto-toggle:not(.on) .auto-label { opacity: 0.85; }
      </style>
      <div class="zone left"></div>
      <div class="zone right"></div>
      <div class="pill">
        <div class="row"></div>
        <div class="display"><span class="num"></span><span class="x">×</span></div>
      </div>
      <div class="boost-badge"></div>
      <div class="auto-toggle" role="button" tabindex="0" aria-pressed="false" aria-label="Auto-advance reels">
        <span class="auto-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path class="tri" d="M5 4L5 20L19 12Z"/></svg></span>
        <span class="auto-label">auto</span>
      </div>
      <div class="scrubber">
        <div class="scrubber-track"><div class="scrubber-fill"></div></div>
        <div class="scrubber-thumb"></div>
        <canvas class="scrubber-preview-canvas" width="80" height="142"></canvas>
        <div class="scrubber-label"></div>
      </div>
    `;

    const pill = shadow.querySelector(".pill");
    const display = shadow.querySelector(".display");
    const pillNum = display.querySelector(".num");
    const row = shadow.querySelector(".row");

    const rowButtons = [];
    for (const rate of SPEED_PRESETS) {
      const btn = document.createElement("button");
      btn.dataset.rate = String(rate);
      btn.textContent = formatRate(rate);
      // 4-char rates (1.25 / 1.75) get a smaller font so they don't graze the
      // circle edge — matched to .pill.shrink on the resting display.
      if (String(rate).length >= 4) btn.classList.add("narrow");
      row.appendChild(btn);
      rowButtons.push(btn);
    }

    function setRate(r) {
      const prev = video.playbackRate;
      video.playbackRate = r;
      pillNum.textContent = String(r);
      pill.classList.toggle("shrink", String(r).length >= 4);
      rowButtons.forEach((b) => {
        b.classList.toggle("active", Number(b.dataset.rate) === r);
      });
      // Briefly emphasize the scrubber so the user can see the playhead
      // change pace (or in the case of skipBy/boost, jump or accelerate).
      if (r !== prev) pulseScrubberActive(600);
    }

    function setOpen(open) {
      pill.classList.toggle("open", open);
      if (!open) rowButtons.forEach((b) => b.classList.remove("preview"));
    }

    function buttonAtPoint(x, y) {
      for (const b of rowButtons) {
        const r = b.getBoundingClientRect();
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return b;
      }
      return null;
    }

    // Pointer interaction model — a single press handles both tap-to-open
    // and press-and-slide:
    //   - Pointerdown on closed pill → opens it; start tracking pointer.
    //   - Pointermove past ~6px → "preview" highlight follows cursor.
    //   - Pointerup with a preview → commit that rate and close.
    //   - Pointerup without a drag, pill was already open → treat as tap-to-
    //     select on whatever button is under the cursor.
    //   - Pointerup without a drag on a *just-opened* pill → stay open so the
    //     user can take a second tap to pick.
    //
    // pointerdown (not click) because IG's capture-phase click handler
    // (especially on Reels) registers before our content script — preventing
    // pointerdown is the only way to stop the synthesized tap-to-pause.
    let pointerHeld = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let dragPreview = null;
    let openedOnThisDown = false;

    function onPillDown(e) {
      e.preventDefault();
      e.stopPropagation();
      pointerHeld = true;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      dragPreview = null;
      openedOnThisDown = !pill.classList.contains("open");
      if (openedOnThisDown) setOpen(true);
      document.addEventListener("pointermove", onDragMove);
      document.addEventListener("pointerup", onDragUp, true);
    }

    function onDragMove(e) {
      if (!pointerHeld) return;
      if (!dragPreview) {
        const dx = e.clientX - dragStartX;
        const dy = e.clientY - dragStartY;
        if (Math.hypot(dx, dy) < 6) return;
      }
      const btn = buttonAtPoint(e.clientX, e.clientY);
      rowButtons.forEach((b) => b.classList.toggle("preview", b === btn));
      dragPreview = btn;
    }

    function onDragUp(e) {
      pointerHeld = false;
      document.removeEventListener("pointermove", onDragMove);
      document.removeEventListener("pointerup", onDragUp, true);
      rowButtons.forEach((b) => b.classList.remove("preview"));
      if (dragPreview) {
        setRate(Number(dragPreview.dataset.rate));
        setOpen(false);
        return;
      }
      if (!openedOnThisDown) {
        const btn = buttonAtPoint(e.clientX, e.clientY);
        if (btn) {
          setRate(Number(btn.dataset.rate));
          setOpen(false);
        }
      }
    }

    // Close on any pointerdown outside our host. Capture phase so we see the
    // event before any IG handlers that might also fire on it.
    function onDocDown(e) {
      if (!host.contains(e.target)) setOpen(false);
    }

    // Side zones — left 25% / right 25%. Three behaviors per zone:
    //   - Tap (release before HOLD_THRESHOLD_MS) → skip ±SKIP_SECONDS.
    //   - Hold (≥HOLD_THRESHOLD_MS) → 2× boost in that direction.
    //   - Center 60% is untouched → IG's native tap-to-pause still works.
    // Reverse boost pauses the video and manually rewinds currentTime via
    // rVFC, since negative playbackRate doesn't work reliably on streaming
    // video.
    const HOLD_THRESHOLD_MS = 250;
    const BOOST_RATE = 2;
    const SKIP_SECONDS = 5;
    // Window in which consecutive same-direction taps stack into one chip
    // (e.g. three quick +5 taps → "+15s"). Longer than a typical double-tap
    // gap (~300ms) so a burst of taps reliably groups, but short enough that
    // a deliberate pause resets to a fresh "+5s".
    const SKIP_STACK_WINDOW_MS = 800;

    const zoneLeft = shadow.querySelector(".zone.left");
    const zoneRight = shadow.querySelector(".zone.right");
    const boostBadge = shadow.querySelector(".boost-badge");
    if (DEBUG) {
      zoneLeft.classList.add("debug");
      zoneRight.classList.add("debug");
    }

    let boostHoldTimer = null;
    let boostMode = null;
    let boostOriginalRate = 1;
    let boostWasPlaying = false;
    let reverseHandle = null;
    let lastReverseFrame = 0;
    let skipBadgeTimer = null;
    let skipStackSeconds = 0;
    let skipStackTime = 0;

    // We keep the video PLAYING during reverse so the element keeps rendering
    // frames, and pace stepBack via requestVideoFrameCallback (rVFC) — it
    // fires only after the <video> actually paints a new frame, which
    // naturally throttles us to the decoder's real throughput. rAF would
    // queue ~60 seeks/sec; Chrome coalesces seeks issued faster than the
    // decoder can serve, so most got dropped and reverse looked strobey.
    // rVFC paces 1:1 with painted frames, so every issued seek lands.
    //
    // The rapid currentTime writes also prevent the playhead from advancing
    // forward between seeks (verified empirically: each frame's `before`
    // equals the prior frame's `after`), so we rewind exactly BOOST_RATE × dt
    // per frame and that is the net reverse rate.
    const useVFC = typeof video.requestVideoFrameCallback === "function";
    let stepBackFrames = 0;
    function stepBack(now) {
      const dt = (now - lastReverseFrame) / 1000;
      lastReverseFrame = now;
      const before = video.currentTime;
      const next = before - BOOST_RATE * dt;
      if (next <= 0) {
        video.currentTime = 0;
        reverseHandle = null;
        return;
      }
      video.currentTime = next;
      if (video.paused) video.play().catch(() => {});
      if (stepBackFrames < 3 || stepBackFrames % 30 === 0) {
        dlog(
          "[Maestro] stepBack frame", stepBackFrames,
          "dt", dt.toFixed(4),
          "before", before.toFixed(3),
          "set", next.toFixed(3),
          "after", video.currentTime.toFixed(3),
          "paused", video.paused,
          "via", useVFC ? "vfc" : "raf"
        );
      }
      stepBackFrames++;
      reverseHandle = useVFC
        ? video.requestVideoFrameCallback(stepBack)
        : requestAnimationFrame(stepBack);
    }

    // While a boost is active we hide IG's chrome around this video so the
    // user gets the same "video alone with the badge" focus that mobile IG
    // gives. We walk the video's ancestor chain up to its closest container
    // (article on Home/Explore; otherwise an ancestor whose rect roughly
    // matches the video, which works for Reels) and tag every sibling along
    // the way — that covers the post header, caption, action bar, and any
    // overlay buttons (including mute) without needing fragile IG class
    // selectors. Plus our own pill, hidden via its own .hidden class.
    let hiddenChrome = [];

    function findVideoContainer() {
      const article = video.closest("article");
      if (article) return article;
      const vr = video.getBoundingClientRect();
      let cur = video.parentElement;
      let best = cur;
      while (cur && cur !== document.body) {
        const r = cur.getBoundingClientRect();
        if (r.width > vr.width * 1.3 || r.height > vr.height * 1.3) break;
        best = cur;
        cur = cur.parentElement;
      }
      return best || video.parentElement;
    }

    // Decide whether a sibling of the video (at any walk level) should be
    // hidden during boost/skip.
    //
    // Three cases:
    //   1. Sibling has a non-zero rect that overlays the video → tag. This
    //      is the obvious overlay case (caption bar, mute button, etc.).
    //   2. Sibling has a non-zero rect that sits BESIDE/BELOW the video
    //      (Reels side rail, Home action rail, post header) → don't tag.
    //   3. Sibling has a 0×0 rect → tag. This catches transparent wrappers
    //      whose children are absolutely-positioned and so collapse the
    //      wrapper's own layout. Reels' data-instancekey div is the load-
    //      bearing example: class="", no inline size, only child is
    //      position:absolute + inset:0 — wrapper rect is 0×0, but its
    //      descendants (caption bar, follow button, mute) fully overlay
    //      the video. Tagging the wrapper sets opacity:0 on it, which
    //      inherits down to those descendants.
    function shouldHideSibling(sib, vr) {
      const r = sib.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return true;
      return !(
        r.right <= vr.left ||
        r.left >= vr.right ||
        r.bottom <= vr.top ||
        r.top >= vr.bottom
      );
    }

    function collectChromeToHide() {
      const container = findVideoContainer();
      if (!container) return [];
      const out = [];
      const vr = video.getBoundingClientRect();
      let cur = video;
      while (cur && cur !== container) {
        const parent = cur.parentElement;
        if (!parent) break;
        for (const sib of parent.children) {
          if (sib === cur) continue;
          if (shouldHideSibling(sib, vr)) out.push(sib);
        }
        cur = parent;
      }
      return out;
    }

    function hideChrome() {
      // On post-detail / permalink pages (/p/<id>, /<user>/p/<id>) IG's
      // chrome (profile header, action rail, caption, comments) lives in a
      // column ALONGSIDE the video — it's permanent UI, not a transient
      // overlay. Hiding it on a skip/boost is jarring. Skip on those URLs
      // and leave the page chrome alone.
      if (isPostDetailPage()) return;
      // Idempotent: don't re-collect if already hidden, so a skip-flash that
      // hides chrome and then enters a boost mid-flash doesn't lose track of
      // the original tagged elements (and a subsequent showChrome correctly
      // un-tags everything it tagged).
      if (hiddenChrome.length === 0) {
        hiddenChrome = collectChromeToHide();
      }
      hiddenChrome.forEach((el) => el.classList.add("maestro-boost-hidden"));
      pill.classList.add("hidden");
      // Scrubber stays visible during skip/boost so the user can watch the
      // playhead jump on a skip and accelerate during 2× boost — it's the
      // most useful real-time feedback for the very controls that change
      // currentTime, so hiding it would defeat the purpose.
    }

    function showChrome() {
      hiddenChrome.forEach((el) => el.classList.remove("maestro-boost-hidden"));
      hiddenChrome = [];
      pill.classList.remove("hidden");
    }

    function enterBoost(mode) {
      if (boostMode) return;
      dlog("[Maestro] enterBoost", mode, "wasPlaying", !video.paused, "t", video.currentTime.toFixed(3), "rate", video.playbackRate);
      boostMode = mode;
      boostOriginalRate = video.playbackRate;
      boostWasPlaying = !video.paused;
      if (mode === "fwd") {
        if (!boostWasPlaying) video.play().catch(() => {});
        video.playbackRate = BOOST_RATE;
        boostBadge.textContent = "2× ▶▶";
      } else {
        // Keep the video playing during reverse so frames render. IG fires
        // pause() in response to our seeks; counter it by listening for the
        // `pause` event and immediately replaying. This is synchronous with
        // IG's handler, which beats trying to outrace it from rAF.
        video.playbackRate = 1;
        video.play().catch(() => {});
        video.addEventListener("pause", onBoostPauseFight);
        boostBadge.textContent = "◀◀ 2×";
        lastReverseFrame = performance.now();
        stepBackFrames = 0;
        reverseHandle = useVFC
          ? video.requestVideoFrameCallback(stepBack)
          : requestAnimationFrame(stepBack);
      }
      hideChrome();
      boostBadge.classList.add("on");
      setScrubberPersistentActive(true);
    }

    function onBoostPauseFight() {
      if (boostMode === "rev") {
        video.play().catch(() => {});
      }
    }

    function exitBoost() {
      if (!boostMode) return;
      video.removeEventListener("pause", onBoostPauseFight);
      if (reverseHandle) {
        if (useVFC) video.cancelVideoFrameCallback(reverseHandle);
        else cancelAnimationFrame(reverseHandle);
        reverseHandle = null;
      }
      video.playbackRate = boostOriginalRate;
      // Both modes left the video playing during the boost. Restore to the
      // pre-boost play state — if it was paused, pause again; otherwise leave
      // it playing.
      if (!boostWasPlaying) video.pause();
      boostMode = null;
      showChrome();
      boostBadge.classList.remove("on");
      setScrubberPersistentActive(false);
    }

    function flashSkipBadge(seconds) {
      const sign = seconds >= 0 ? "+" : "−";
      boostBadge.textContent = `${sign}${Math.abs(seconds)}s`;
      boostBadge.classList.add("on");
      if (skipBadgeTimer) clearTimeout(skipBadgeTimer);
      skipBadgeTimer = setTimeout(() => {
        skipBadgeTimer = null;
        // If a boost is active by the time the flash ends, it owns the badge
        // text and the chrome-hidden state — leave both alone and let
        // exitBoost handle them.
        if (boostMode) return;
        boostBadge.classList.remove("on");
        showChrome();
      }, 500);
    }

    function skipBy(seconds) {
      const before = video.currentTime;
      const dur = isFinite(video.duration) ? video.duration : Infinity;
      const next = Math.max(0, Math.min(dur, before + seconds));
      if (next === before) return; // at boundary — don't move, don't flash, don't stack
      video.currentTime = next;
      // Flash the scrubber active so the user visibly sees the playhead
      // snap to its new position.
      pulseScrubberActive(600);

      // Stack consecutive same-direction taps within the window into one
      // running total (e.g. "+5s" → "+10s" → "+15s"). Direction change or
      // a long enough pause starts a fresh stack at the new value.
      const now = performance.now();
      const sameDir = (seconds > 0) === (skipStackSeconds > 0);
      const inWindow = now - skipStackTime < SKIP_STACK_WINDOW_MS;
      skipStackSeconds = (inWindow && sameDir && skipStackSeconds !== 0)
        ? skipStackSeconds + seconds
        : seconds;
      skipStackTime = now;
      hideChrome();
      flashSkipBadge(skipStackSeconds);
    }

    // Zone interaction model — document-level, capture-phase, deferred commit.
    //
    // The zones never claim pointer events on their own (pointer-events: none
    // on .zone). Instead, every pointerdown on the document goes through
    // onZoneDocDown, which decides whether this particular press belongs to
    // us based on what's *actually* under the cursor — not just whether the
    // cursor falls in the zone's rect.
    //
    // Two reasons:
    //   1. The zone's rect can overlap IG's action rail (Like/Comment/Share/
    //      Save/More + audio thumb) on compressed Reels. A whole-zone gate
    //      either eats those button clicks or disables the zone everywhere
    //      it overlaps — both are wrong. Per-press hit-test lets the button
    //      receive the click while the rest of the zone still works.
    //   2. preventDefault on pointerdown also cancels native gestures —
    //      notably IG's vertical swipe-to-next-reel. So we DON'T
    //      preventDefault on pointerdown anymore; we wait. If the pointer
    //      moves past ZONE_MOVE_ABORT_PX before we commit, we abandon and
    //      let the browser/IG handle the gesture. If it stays still and
    //      either holds past HOLD_THRESHOLD_MS or lifts quickly, only then
    //      do we take over.
    //
    // Cost of deferring preventDefault: IG's tap-to-pause click handler
    // already fires for the tap by the time we know it's a tap. suppressNextClick
    // catches the synthesized click in capture phase and swallows it.
    const ZONE_MOVE_ABORT_PX = 10;
    let zoneDown = null; // {mode, startX, startY, holdTimer, committed}

    function pointInZone(x, y, zoneEl) {
      const r = zoneEl.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    }

    // Returns the topmost element under (x, y) that ISN'T part of our host
    // overlay. Our host has pointer-events: none, but elementsFromPoint walks
    // through stacking order regardless, so we filter explicitly.
    function topElementBelowHost(x, y) {
      const stack = document.elementsFromPoint(x, y);
      for (const el of stack) {
        if (el === host || host.contains(el)) continue;
        return el;
      }
      return null;
    }

    // True if the cursor is over THIS video — i.e. the press should drive a
    // zone tap/hold, not an IG button.
    //
    // The hard cases:
    //  - On Home both IG action buttons (Like/Comment/...) and tap-catchers
    //    live inside the same <article> as the video, so "inside article"
    //    can't discriminate them.
    //  - On Reels both can have rects bounded by the video, so bounds
    //    containment can't either.
    //  - IG's tap-catcher itself is often role="button", so naively
    //    rejecting all role="button" hits would kill skip in the middle of
    //    the video.
    //
    // Strategy: only step aside for *small interactive controls*. We walk up
    // to the nearest <a>, <button>, or [role="button"] ancestor of the
    // topmost element. If that ancestor's area is well under the video's
    // area, it's an IG icon/button — step aside. The tap-catcher's ancestor
    // is itself, and it's huge, so it falls through. Pure passive overlays
    // (no interactive ancestor) also fall through.
    function isPressOnVideo(x, y, videoRect) {
      const top = topElementBelowHost(x, y);
      if (!top) return false;
      if (top === video || top.contains(video)) return true;

      const videoArea = videoRect.width * videoRect.height;
      const interactive = top.closest('a, button, [role="button"]');
      if (interactive && videoArea > 0) {
        const ir = interactive.getBoundingClientRect();
        const interactiveArea = ir.width * ir.height;
        // <25% of video area → small icon/button = IG chrome, step aside.
        if (interactiveArea / videoArea < 0.25) return false;
      }

      // Otherwise treat as a press on the video / a tap-catcher overlay.
      // Accept if inside the post container (Home/Explore) or bounded by
      // the video's rect (Reels body-level overlays).
      const article = video.closest("article");
      if (article && article.contains(top)) return true;
      const tr = top.getBoundingClientRect();
      return (
        tr.left >= videoRect.left - 4 &&
        tr.right <= videoRect.right + 4 &&
        tr.top >= videoRect.top - 4 &&
        tr.bottom <= videoRect.bottom + 4
      );
    }

    // One-shot click swallower. IG's tap-to-pause is a click handler on
    // `document` in capture phase, registered before our content script loads,
    // so a document-capture listener of ours would fire AFTER IG's and be
    // useless. Registering on `window` makes us run earlier in the capture
    // chain (window → document → target), so stopPropagation here stops IG's
    // document-level handler from firing at all.
    function suppressNextClick() {
      const handler = (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        cleanup();
      };
      const cleanup = () => {
        window.removeEventListener("click", handler, true);
        clearTimeout(timer);
      };
      const timer = setTimeout(cleanup, 400);
      window.addEventListener("click", handler, true);
    }

    function onZoneDocDown(e) {
      if (e.button != null && e.button !== 0) return;
      if (zoneDown || boostMode) return;
      // The open pill (208px) extends into the right zone on compressed
      // Reels. Our hit-test sees the video below the pill (host is skipped)
      // and would claim the press, killing the pill's own pointerdown.
      const pillRect = pill.getBoundingClientRect();
      if (
        e.clientX >= pillRect.left && e.clientX <= pillRect.right &&
        e.clientY >= pillRect.top && e.clientY <= pillRect.bottom
      ) return;
      // Same for the auto-advance toggle — it sits over the right rail, inside
      // the right zone. Without this the zone would claim the press (the video
      // is below our host) and fire a skip instead of flipping the toggle.
      if (autoToggle.style.display !== "none") {
        const atRect = autoToggle.getBoundingClientRect();
        if (
          e.clientX >= atRect.left && e.clientX <= atRect.right &&
          e.clientY >= atRect.top && e.clientY <= atRect.bottom
        ) return;
      }
      const rect = video.getBoundingClientRect();
      const visible = isVideoVisible(rect);
      const blockedModal = isBlockedByOtherModal();
      if (!visible || blockedModal) {
        dlog("[Maestro debug] pointerdown REJECTED — visible:", visible, "blockedModal:", blockedModal);
        return;
      }

      let mode = null;
      if (pointInZone(e.clientX, e.clientY, zoneLeft)) mode = "rev";
      else if (pointInZone(e.clientX, e.clientY, zoneRight)) mode = "fwd";
      if (!mode) {
        dlog(
          "[Maestro debug] pointerdown NOT IN ZONE — pt:", e.clientX, e.clientY,
          "zoneL:", zoneLeft.getBoundingClientRect(),
          "zoneR:", zoneRight.getBoundingClientRect(),
          "videoRect:", rect
        );
        return;
      }

      // Step aside for IG's own volume control (the mute button + the slider
      // that slides up from it). It can sit against the left/right margin,
      // inside this zone — without this its hover/drag gets stolen and we'd
      // fire a skip/boost instead of letting the user set the volume.
      if (isPressOnIGVolumeControl(e.clientX, e.clientY)) {
        dlog("[Maestro debug] pointerdown REJECTED — on IG volume control");
        return;
      }

      // Don't take the press if it's actually over an IG button, link, or
      // other non-video chrome that happens to overlap the zone.
      if (!isPressOnVideo(e.clientX, e.clientY, rect)) {
        if (DEBUG) {
          const top = topElementBelowHost(e.clientX, e.clientY);
          dlog(
            "[Maestro debug] pointerdown REJECTED (not on video) — mode:", mode,
            "top:", top,
            "interactive ancestor:", top && top.closest('a, button, [role="button"]')
          );
        }
        return;
      }

      dlog("[Maestro debug] pointerdown CLAIMED — mode:", mode, "pointerType:", e.pointerType, "URL:", location.pathname);

      setOpen(false);

      zoneDown = {
        mode,
        startX: e.clientX,
        startY: e.clientY,
        committed: null,
        holdTimer: setTimeout(() => {
          if (!zoneDown || zoneDown.committed) return;
          zoneDown.committed = "hold";
          enterBoost(zoneDown.mode);
        }, HOLD_THRESHOLD_MS),
      };

      // We claimed this pointerdown — block IG from receiving it. Because we
      // registered on WINDOW capture (see addEventListener below), our handler
      // runs before IG's document-level handlers regardless of who registered
      // first. stopImmediatePropagation here prevents IG's pointerdown
      // listeners (which navigate into post-detail on Home) from ever firing.
      e.stopPropagation();
      e.stopImmediatePropagation();
      // On mouse, also preventDefault to suppress the mouse-event
      // compatibility sequence (mousedown → mouseup → click) — belt-and-
      // suspenders for any IG handler that lives on those events.
      // For touch we MUST defer — preventDefault on a touch pointerdown
      // cancels native vertical swipe (swipe-to-next-reel on Reels), which
      // we want to keep when the user is panning rather than tapping.
      if (e.pointerType === "mouse") {
        e.preventDefault();
      }

      document.addEventListener("pointermove", onZoneDocMove, true);
      // pointerup/pointercancel on WINDOW capture (not document) so we beat
      // IG's document-level handlers regardless of registration order.
      // On Home, IG navigates into the post detail from a pointerup-/mouseup-
      // based handler (not click), so a document-capture listener we add at
      // document_idle would fire AFTER IG's and be too late.
      window.addEventListener("pointerup", onZoneDocUp, true);
      window.addEventListener("pointercancel", onZoneDocCancel, true);
    }

    function onZoneDocMove(e) {
      if (!zoneDown || zoneDown.committed) return;
      const dx = e.clientX - zoneDown.startX;
      const dy = e.clientY - zoneDown.startY;
      if (Math.hypot(dx, dy) > ZONE_MOVE_ABORT_PX) {
        // Moved before commit — user is scrolling or swiping. Let the
        // browser/IG own the gesture; we never preventDefault'd, so it
        // proceeds normally.
        clearZoneDown();
      }
    }

    function onZoneDocUp(e) {
      if (!zoneDown) return;
      const committed = zoneDown.committed;
      const mode = zoneDown.mode;
      // Once we know this is our gesture, kill the event completely.
      // preventDefault on pointerup cancels the synthesized mouseup + click
      // (per Pointer Events spec), which kills IG's click-based handlers.
      // stopImmediatePropagation on the window-capture listener stops IG's
      // own pointerup-based handlers (Home post-open) from running at all.
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      clearZoneDown();
      // Swallow the synthesized click on BOTH paths. Spec says preventDefault
      // on pointerup cancels the click, but Chrome doesn't always honor it —
      // if the click slips through, IG's tap-to-pause handler fires AFTER
      // exitBoost() runs and pauses the video the user just finished
      // boosting through. Same risk on the tap path; covered here for both.
      suppressNextClick();
      if (committed === "hold") {
        exitBoost();
        return;
      }
      skipBy(mode === "fwd" ? SKIP_SECONDS : -SKIP_SECONDS);
    }

    function onZoneDocCancel() {
      if (!zoneDown) return;
      const committed = zoneDown.committed;
      clearZoneDown();
      if (committed === "hold") exitBoost();
    }

    function clearZoneDown() {
      if (zoneDown && zoneDown.holdTimer) clearTimeout(zoneDown.holdTimer);
      zoneDown = null;
      document.removeEventListener("pointermove", onZoneDocMove, true);
      window.removeEventListener("pointerup", onZoneDocUp, true);
      window.removeEventListener("pointercancel", onZoneDocCancel, true);
    }

    // Registered on WINDOW capture (not document) so we run before IG's
    // document-level pointerdown handlers regardless of registration order —
    // IG loads first and would otherwise win on document-capture.
    window.addEventListener("pointerdown", onZoneDocDown, true);

    // Capture-phase logger that prints any pointerdown landing inside our
    // host's rect — what element/path the press actually hit. Gated on DEBUG
    // so it doesn't ship to production.
    function onDocDownDebug(e) {
      const r = host.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right) return;
      if (e.clientY < r.top || e.clientY > r.bottom) return;
      const xPct = (((e.clientX - r.left) / r.width) * 100).toFixed(1);
      const yPct = (((e.clientY - r.top) / r.height) * 100).toFixed(1);
      const path = e.composedPath().slice(0, 6).map((n) =>
        n.tagName
          ? `${n.tagName.toLowerCase()}${n.id ? "#" + n.id : ""}${
              n.className && typeof n.className === "string"
                ? "." + n.className.split(" ").slice(0, 2).join(".").slice(0, 40)
                : ""
            }`
          : String(n)
      );
      dlog(
        "[Maestro debug] pointerdown @",
        `${xPct}% x ${yPct}% of host`,
        "target=", e.target,
        "path[0..5]=", path
      );
    }
    if (DEBUG) {
      document.addEventListener("pointerdown", onDocDownDebug, true);
    }

    // If IG's post header (avatar/username/...) overlays the top of the video,
    // its "More options" button is the easiest signal — find it and push the
    // pill below the header band so they don't collide.
    function headerOverlapPx(videoRect) {
      const buttons = document.querySelectorAll('[aria-label="More options"]');
      let maxBottomWithinVideo = 0;
      for (const b of buttons) {
        const br = b.getBoundingClientRect();
        if (br.width === 0) continue;
        const horizOverlap = br.right > videoRect.left && br.left < videoRect.right;
        const inTopBand = br.top < videoRect.top + 80 && br.bottom > videoRect.top;
        if (horizOverlap && inTopBand) {
          maxBottomWithinVideo = Math.max(maxBottomWithinVideo, br.bottom - videoRect.top);
        }
      }
      return maxBottomWithinVideo > 0 ? Math.ceil(maxBottomWithinVideo + 4) : 0;
    }

    // True only if the video is actually rendered at its own coordinates.
    // Catches occlusion by IG's post-detail modal (the Home feed video stays
    // in the DOM behind the modal; rect.width/height stay non-zero).
    //
    // IG layers transparent click-catcher overlays as *siblings* of the video,
    // so elementFromPoint at the video's center usually returns one of those,
    // not the video itself. We treat anything inside the video's post
    // container (closest <article>, with parent fallback) as "visible";
    // anything outside (e.g. a body-level modal overlay) counts as occluded.
    function isVideoVisible(rect) {
      if (rect.width < 4 || rect.height < 4) return false;
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) return false;
      const top = document.elementFromPoint(cx, cy);
      if (!top) return false;
      if (top === video || top.contains(video)) return true;
      // Same post container — covers IG's tap-overlay siblings in feed/Explore.
      const article = video.closest("article");
      if (article && article.contains(top)) return true;
      // Reels has no <article>; its tap-overlay is mounted higher up, often at
      // body level. If the topmost element's bounds are contained within the
      // video's bounds, treat it as a tap-overlay (video is visible behind it).
      // A real modal has different bounds (centered or full-viewport-with-dim).
      const tr = top.getBoundingClientRect();
      return (
        tr.left >= rect.left - 4 &&
        tr.right <= rect.right + 4 &&
        tr.top >= rect.top - 4 &&
        tr.bottom <= rect.bottom + 4
      );
    }

    // True if an IG modal dialog is open *and* doesn't contain our video.
    // On Reels web, Share/Comments open as side panels (role="dialog"
    // aria-modal="true", body-mounted) that sit beside the video without
    // dimming it — so isVideoVisible still passes, but our left/right
    // zones float on top of the panel's edges and eat clicks (including
    // the Close X). Hiding the whole host while such a modal is open
    // hands those clicks back. When the user clicks into a Home post
    // detail, the modal contains a *new* video — that video's own pill
    // stays visible (its container IS the modal), only the underlying
    // feed video's pill hides.
    function isBlockedByOtherModal() {
      const modals = document.querySelectorAll(
        '[role="dialog"][aria-modal="true"]'
      );
      for (const modal of modals) {
        if (modal.contains(video)) continue;
        // IG sometimes leaves a [role="dialog"] in the DOM after closing it
        // (display:none, or unmounted slightly later). Treat zero-area dialogs
        // as "not blocking" so the host comes back when the popup is visually
        // gone, even if its DOM node lingers a moment.
        const r = modal.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return true;
      }
      return false;
    }

    // Keep the host glued to the video as IG scrolls/resizes/swipes. We hide
    // the host entirely when the video is off-screen or occluded so the pill
    // doesn't sit on top of unrelated content. Zones no longer need a periodic
    // occlusion gate — onZoneDocDown hit-tests fresh on every press, so a
    // sidebar/panel opening or closing is handled in real time without state.
    // Mirror IG's mute button onto the resting pill — match its rendered
    // diameter, corner radius, and background color so the two read as a
    // matched pair. Keyed off the live DOM (not IG's obfuscated classes), so
    // it self-corrects when IG restyles or the viewport resizes. Throttled to
    // ~2×/sec and only writes when a value actually changed (no style thrash).
    // Falls back to the pill's CSS defaults whenever no button is mounted.
    let appliedPillSize = 0;
    let appliedPillBg = "";
    let appliedPillTrans = "";
    let lastPillSyncTs = 0;
    function syncPillToMuteButton() {
      const btn = findIGMuteButton(video);
      if (!btn) return;
      // Diameter + corner radius + background, from the mute button's
      // painted circle.
      const backdrop = muteButtonBackdrop(btn);
      const rectEl = backdrop ? backdrop.el : btn;
      const r = rectEl.getBoundingClientRect();
      const size = Math.round(Math.min(r.width, r.height));
      if (size && size >= 8) {
        const bg = backdrop ? backdrop.bg : "rgba(0, 0, 0, 0.5)";
        if (size !== appliedPillSize || bg !== appliedPillBg) {
          appliedPillSize = size;
          appliedPillBg = bg;
          pill.style.setProperty("--m-size", `${size}px`);
          pill.style.setProperty("--m-radius", `${size / 2}px`);
          pill.style.setProperty("--m-bg", bg);
          dlog("[Maestro] pill synced to mute button — size", size, "bg", bg);
        }
      }
      // Open-animation pace — match IG's volume panel expand. Inline styles
      // override the .pill rule's default `transition: width 220ms …`; we pin
      // transition-property to width so only the open/close animates (not the
      // --m-bg swap above).
      const trans = getIGVolumeTransition();
      if (trans) {
        const key = `${trans.duration} ${trans.timing}`;
        if (key !== appliedPillTrans) {
          appliedPillTrans = key;
          pill.style.transitionProperty = "width";
          pill.style.transitionDuration = trans.duration;
          pill.style.transitionTimingFunction = trans.timing;
          dlog("[Maestro] pill open-timing synced to IG —", key);
        }
      }
    }
    function maybeSyncPillToMuteButton() {
      const now = performance.now();
      if (now - lastPillSyncTs < 500) return;
      lastPillSyncTs = now;
      syncPillToMuteButton();
    }

    let lastVisibilityState = null; // for change-only debug logging
    function updatePosition() {
      const rect = video.getBoundingClientRect();
      const visible = isVideoVisible(rect);
      const blockedModal = isBlockedByOtherModal();
      if (!visible || blockedModal) {
        host.style.display = "none";
        setOpen(false);
        if (DEBUG && lastVisibilityState !== "hidden") {
          dlog(
            "[Maestro debug] host HIDDEN — visible:", visible,
            "blockedModal:", blockedModal,
            "rect:", rect,
            "URL:", location.pathname
          );
          lastVisibilityState = "hidden";
        }
        return;
      }
      host.style.display = "block";
      host.style.left = `${rect.left}px`;
      host.style.top = `${rect.top}px`;
      host.style.width = `${rect.width}px`;
      host.style.height = `${rect.height}px`;

      const offset = headerOverlapPx(rect);
      pill.style.top = `${8 + offset}px`;

      maybeSyncPillToMuteButton();
      updateAutoTogglePosition(rect);

      if (DEBUG && lastVisibilityState !== "shown") {
        dlog("[Maestro debug] host SHOWN — rect:", rect, "URL:", location.pathname);
        lastVisibilityState = "shown";
      }
    }

    pill.addEventListener("pointerdown", onPillDown);
    document.addEventListener("pointerdown", onDocDown, true);

    // Hover-to-expand (mouse only), mirroring IG's audio toggle which slides
    // open the instant you hover it. The pill grows leftward from its anchored
    // right edge, so the cursor stays inside the expanded box and won't trip an
    // immediate pointerleave. Touch has no hover, so tap-to-open (onPillDown)
    // stays the path there. pointerleave is guarded on pointerHeld so a
    // press-and-slide selection isn't collapsed out from under the cursor.
    pill.addEventListener("pointerenter", (e) => {
      if (e.pointerType === "mouse") setOpen(true);
    });
    pill.addEventListener("pointerleave", (e) => {
      if (e.pointerType === "mouse" && !pointerHeld) setOpen(false);
    });

    const ro = new ResizeObserver(updatePosition);
    ro.observe(video);
    // Capture-phase so scrolls in any nested scroll container update us too.
    document.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
    // loadedmetadata: <video> first gets intrinsic dimensions.
    // "resize" on HTMLVideoElement: intrinsic size changed mid-playback.
    video.addEventListener("loadedmetadata", updatePosition);
    video.addEventListener("resize", updatePosition);

    // Set by the auto-skip block below to tear down its listeners/timers and
    // restore any blanking; called from cleanup(). Null when AUTO_SKIP_PROMOTED
    // is off.
    let promotedSkipTeardown = null;

    // Auto-skip promoted reels — re-armed on every reel *activation*, not once
    // per mount.
    //
    // IG virtualizes the Reels feed: it keeps a small pool of <video> elements
    // mounted and swaps their source + surrounding DOM as you scroll, so one
    // element shows many reels over its life and is rarely unmounted between
    // them. The old per-mount latch fired exactly once per element — the first
    // ad only. Scrolling back to an ad, or forward into a later ad on a reused
    // element, never re-checked (the latch / check budget was already spent).
    //
    // Model now:
    //   - armPromotedSkip() resets the latch and runs a short, bounded retry
    //     sweep. It's called whenever the element (re)activates on a reel:
    //     `play` (scroll-snap autoplay makes a reel the active item) and
    //     `loadstart` (IG repointed this pooled element at a different reel).
    //   - The retry sweep exists because IG often hasn't painted the disclosure
    //     DOM ("Ad" badge text / ig_redirect link) at the instant playback
    //     starts; we re-check a few times over ~1.2s, then stop until the next
    //     activation — rather than bleeding a budget on every timeupdate.
    //   - On `pause`/`emptied` we drop the latch so the next activation
    //     re-checks. This is what makes scrolling *back* to an ad skip again.
    //   - The page gate lives inside the check (not at hook-attach time) so an
    //     element first mounted off the Reels feed still works after an SPA
    //     navigation into Reels.
    if (AUTO_SKIP_PROMOTED) {
      let promotedSkipLatched = false; // a skip is already in flight this episode
      let hiddenForAd = null;          // container we blanked, to restore later
      let sweepTimers = [];

      const clearSweep = () => {
        for (const t of sweepTimers) clearTimeout(t);
        sweepTimers = [];
      };
      const restoreHidden = () => {
        if (hiddenForAd) {
          hiddenForAd.style.visibility = "";
          hiddenForAd = null;
        }
      };

      const checkPromoted = (trigger) => {
        if (promotedSkipLatched) return;
        if (!isReelsFeedPage()) return;
        if (!isPromotedReel(video)) return;
        promotedSkipLatched = true;
        clearSweep();
        // Pin the travel direction NOW (when we detected the ad) so the skip
        // continues the way the user is scrolling — our own scrollBy below
        // would otherwise overwrite lastReelScrollDir before the timer fires.
        const dir = lastReelScrollDir;
        // Black out the promoted reel IMMEDIATELY so the user doesn't see it
        // during the brief delay before we scroll past. visibility:hidden keeps
        // the layout box so scroll-snap math stays correct (see hidePromotedReel).
        hiddenForAd = hidePromotedReel(video);
        const delay = PROMOTED_SKIP_DELAY_MIN_MS +
          Math.random() * (PROMOTED_SKIP_DELAY_MAX_MS - PROMOTED_SKIP_DELAY_MIN_MS);
        dlog("[Maestro] promoted-skip via", trigger, "— skipping", dir, "in", Math.round(delay), "ms", video);
        // Track the skip timer in sweepTimers so it's cancelled if the reel
        // goes inactive first (scrolled away / IG auto-advanced) — otherwise a
        // late skip would yank an unrelated reel.
        sweepTimers.push(setTimeout(() => skipReel(dir), delay));
      };

      const armPromotedSkip = (trigger) => {
        clearSweep();
        promotedSkipLatched = false;
        // (Re)activating on a fresh reel — undo any blanking left from a prior
        // ad so a recycled non-ad reel isn't stranded hidden.
        restoreHidden();
        for (const t of [0, 60, 150, 300, 600, 1200]) {
          sweepTimers.push(setTimeout(() => checkPromoted(`${trigger}+${t}`), t));
        }
      };

      const onActivate = () => armPromotedSkip("play");
      const onLoadStart = () => armPromotedSkip("loadstart");
      // Reel went inactive (scrolled away) — drop the latch so the next
      // activation re-checks. Keep any blanking until the next activation so
      // there's no flash as we scroll off the ad.
      const onPause = () => { clearSweep(); promotedSkipLatched = false; };
      // Source cleared — same, plus restore blanking since this element is
      // about to be repointed at different content.
      const onEmptied = () => { onPause(); restoreHidden(); };

      video.addEventListener("play", onActivate);
      video.addEventListener("loadstart", onLoadStart);
      video.addEventListener("pause", onPause);
      video.addEventListener("emptied", onEmptied);
      if (!video.paused) armPromotedSkip("immediate");
      dlog("[Maestro] promoted-skip: re-arming hook attached", video);

      promotedSkipTeardown = () => {
        clearSweep();
        restoreHidden();
        video.removeEventListener("play", onActivate);
        video.removeEventListener("loadstart", onLoadStart);
        video.removeEventListener("pause", onPause);
        video.removeEventListener("emptied", onEmptied);
      };
    }

    // Auto-advance toggle (Reels). Reflects the global autoAdvanceEnabled,
    // flips it on click / Enter / Space, and re-syncs whenever any *other*
    // reel's toggle changes the shared value (via autoAdvanceListeners).
    const autoToggle = shadow.querySelector(".auto-toggle");
    const autoIcon = shadow.querySelector(".auto-icon");
    const autoLabel = shadow.querySelector(".auto-label");
    let renderedOn = null;
    function popIcon() {
      // Restart the keyframe each time: remove, force reflow, re-add.
      autoIcon.classList.remove("pop");
      void autoIcon.offsetWidth;
      autoIcon.classList.add("pop");
    }
    function renderAutoToggle(on) {
      const wasOn = renderedOn;
      renderedOn = on;
      autoToggle.classList.toggle("on", on);
      autoToggle.setAttribute("aria-pressed", on ? "true" : "false");
      // Pop only on a real off→on flip — not the initial mount (wasOn === null)
      // or a redundant on→on re-render.
      if (on && wasOn === false) popIcon();
    }
    renderAutoToggle(autoAdvanceEnabled);
    autoAdvanceListeners.add(renderAutoToggle);
    function onAutoToggleActivate(e) {
      e.preventDefault();
      e.stopPropagation();
      setAutoAdvance(!autoAdvanceEnabled);
    }
    autoToggle.addEventListener("pointerdown", onAutoToggleActivate);
    autoToggle.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " " || e.code === "Space") {
        onAutoToggleActivate(e);
      }
    });

    // Mirror IG's rail count font onto our "auto" label so it reads as part of
    // the rail. Throttled (~2×/sec) and only writes on change, like the pill's
    // mute-button sync — no style thrash. `fromEl` is the located Like <svg>.
    let appliedLabelFont = "";
    let lastLabelFontTs = 0;
    function maybeSyncAutoLabelFont(fromEl) {
      const now = performance.now();
      if (now - lastLabelFontTs < 500) return;
      lastLabelFontTs = now;
      const f = getIGRailLabelFont(fromEl);
      if (!f) return;
      const key = [f.fontFamily, f.fontSize, f.fontWeight, f.letterSpacing, f.lineHeight].join("|");
      if (key === appliedLabelFont) return;
      appliedLabelFont = key;
      autoLabel.style.fontFamily = f.fontFamily;
      autoLabel.style.fontSize = f.fontSize;
      autoLabel.style.fontWeight = f.fontWeight;
      autoLabel.style.letterSpacing = f.letterSpacing;
      autoLabel.style.lineHeight = f.lineHeight;
      dlog("[Maestro] auto-label font synced to IG rail —", key);
    }

    // Mirror IG's hover-grow timing + scale onto our icon and label. The CSS
    // rules drive WHICH element grows (icon hover → both; label hover → label);
    // here we just feed them IG's values via the --m-hover-scale var and inline
    // transition timing. Throttled + change-gated like the font sync.
    let appliedHoverKey = "";
    let lastHoverSyncTs = 0;
    function maybeSyncAutoHover(likeSvg) {
      const now = performance.now();
      if (now - lastHoverSyncTs < 500) return;
      lastHoverSyncTs = now;
      const btn = likeSvg.closest('[role="button"]');
      if (!btn) return;
      const h = getIGRailHover(btn);
      const key = `${h.scale}|${h.duration}|${h.timing}`;
      if (key === appliedHoverKey) return;
      appliedHoverKey = key;
      autoToggle.style.setProperty("--m-hover-scale", String(h.scale));
      for (const el of [autoIcon, autoLabel]) {
        el.style.transitionProperty = "transform";
        el.style.transitionDuration = h.duration;
        el.style.transitionTimingFunction = h.timing;
      }
      dlog("[Maestro] auto hover synced from IG — scale", h.scale, h.duration, h.timing);
    }

    // Drop the toggle into IG's action rail one slot above the Like icon, at the
    // rail's own icon-to-icon pitch so the gap matches the native spacing — and
    // centered on the same column so it lines up horizontally. Reels feed only,
    // and only while the rail is actually mounted; otherwise hidden. Half of the
    // 28px icon (14px) maps our icon's CENTER to the computed target, since the
    // toggle is a top-anchored column with the icon first.
    const AUTO_ICON_HALF = 14;
    function updateAutoTogglePosition(videoRect) {
      if (!isReelsFeedPage()) { autoToggle.style.display = "none"; return; }
      // A skipped promoted reel is blanked via visibility:hidden on its
      // container (hidePromotedReel) for the brief beat before we scroll past.
      // visibility:hidden PRESERVES layout, so the rail still lays out and we'd
      // otherwise keep the toggle floating over the blanked ad while everything
      // else is gone. The video inherits that hidden visibility — key off it.
      if (getComputedStyle(video).visibility === "hidden") {
        autoToggle.style.display = "none";
        return;
      }
      const icons = getReelRailIcons(video);
      const like = icons.find((i) => i.label === "Like" || i.label === "Unlike");
      if (!like) { autoToggle.style.display = "none"; return; }
      // Pitch from the live rail; fall back to a typical reel spacing if we
      // can't measure (e.g. only the heart is mounted for a beat).
      const pitch = railIconPitch(icons) || 56;
      const targetIconCenterY = like.cy - pitch;
      autoToggle.style.left = `${like.cx - videoRect.left}px`;
      autoToggle.style.top = `${targetIconCenterY - AUTO_ICON_HALF - videoRect.top}px`;
      autoToggle.style.display = "flex";
      maybeSyncAutoLabelFont(like.svg);
      maybeSyncAutoHover(like.svg);
    }

    // Auto-advance trigger — mirror the promoted-skip lifecycle: a per-play
    // latch (re-armed on activation) so we advance exactly once, just as the
    // reel finishes its first play. Gated to the centered reel so a background
    // pooled <video> can't advance the feed. skipReel("down") reuses the same
    // three fallback strategies as the ad-skip, so it works headlessly too.
    let autoAdvanceLatched = false;
    function onAutoAdvanceTimeupdate() {
      if (!autoAdvanceEnabled || autoAdvanceLatched) return;
      if (!isReelsFeedPage()) return;
      const dur = video.duration;
      if (!isFinite(dur) || dur <= 0) return;
      if (dur - video.currentTime > AUTO_ADVANCE_LEAD_S) return;
      const rect = video.getBoundingClientRect();
      const mid = window.innerHeight / 2;
      if (rect.top > mid || rect.bottom < mid) return; // not the active reel
      autoAdvanceLatched = true;
      dlog("[Maestro] auto-advance: reel finished one play → next reel", video);
      skipReel("down");
    }
    function onAutoAdvanceReset() { autoAdvanceLatched = false; }
    video.addEventListener("timeupdate", onAutoAdvanceTimeupdate);
    video.addEventListener("play", onAutoAdvanceReset);
    video.addEventListener("loadstart", onAutoAdvanceReset);
    video.addEventListener("emptied", onAutoAdvanceReset);

    // Scrubber wiring — mobile-IG-style draggable progress bar.
    const scrubber = shadow.querySelector(".scrubber");
    const scrubFill = shadow.querySelector(".scrubber-fill");
    const scrubThumb = shadow.querySelector(".scrubber-thumb");
    const scrubLabel = shadow.querySelector(".scrubber-label");
    const scrubPreview = shadow.querySelector(".scrubber-preview-canvas");
    const scrubPreviewCtx = scrubPreview.getContext("2d");
    if (SHOW_FRAME_PREVIEW) scrubber.classList.add("with-preview");

    // .active = thicker bar + visible thumb during skip/rate/boost. The
    // persistent flag prevents a pulse timer from clearing .active mid-boost.
    let scrubberPersistentActive = false;
    let scrubActivePulseTimer = null;
    function pulseScrubberActive(durationMs) {
      scrubber.classList.add("active");
      if (scrubActivePulseTimer) clearTimeout(scrubActivePulseTimer);
      scrubActivePulseTimer = setTimeout(() => {
        scrubActivePulseTimer = null;
        if (!scrubberPersistentActive) scrubber.classList.remove("active");
      }, durationMs);
    }
    function setScrubberPersistentActive(on) {
      scrubberPersistentActive = on;
      if (on) {
        scrubber.classList.add("active");
      } else if (!scrubActivePulseTimer) {
        scrubber.classList.remove("active");
      }
    }

    function fmtTime(s) {
      if (!isFinite(s) || s < 0) s = 0;
      const m = Math.floor(s / 60);
      const sec = Math.floor(s % 60);
      return `${m}:${sec.toString().padStart(2, "0")}`;
    }

    function syncScrubberFromVideo() {
      const dur = video.duration;
      if (!isFinite(dur) || dur <= 0) {
        scrubber.classList.add("disabled");
        return;
      }
      scrubber.classList.remove("disabled");
      if (scrubDragging) return;
      const pctStr = Math.min(1, Math.max(0, video.currentTime / dur)) * 100 + "%";
      scrubFill.style.width = pctStr;
      scrubThumb.style.left = pctStr;
    }

    function seekFromClientX(clientX, commit) {
      const r = scrubber.getBoundingClientRect();
      if (r.width <= 0) return;
      const pct = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
      const dur = video.duration;
      if (!isFinite(dur) || dur <= 0) return;
      const pctStr = (pct * 100) + "%";
      scrubFill.style.width = pctStr;
      scrubThumb.style.left = pctStr;
      if (commit) video.currentTime = pct * dur;
    }

    // Clamp overlay (label / preview) horizontally so its full width stays
    // inside the scrubber — pin at the edges, follow once cursor passes
    // the half-width threshold.
    function positionOverlayAtPct(el, pct, scrubberWidth) {
      const halfPct = (el.offsetWidth / 2) / scrubberWidth;
      const clamped = Math.min(1 - halfPct, Math.max(halfPct, pct));
      el.style.left = (clamped * 100) + "%";
    }

    // Frame preview: capture one ImageBitmap per integer second; draw the
    // nearest cached frame on hover/drag. Bounded LRU on the cache.
    const PREVIEW_WIDTH = 80;
    const PREVIEW_MAX_FRAMES = 90;
    const frameCache = new Map();
    let lastCachedSec = -1;
    let previewSized = false;
    // Persisted so the async createImageBitmap resolution can redraw with
    // the freshly cached frame instead of leaving the stale one painted.
    let lastHoverSec = -1;

    function ensurePreviewSized() {
      if (previewSized) return;
      if (!video.videoWidth || !video.videoHeight) return;
      const aspect = video.videoWidth / video.videoHeight;
      const dispH = Math.max(40, Math.round(PREVIEW_WIDTH / aspect));
      // Bitmap at DPR for retina crispness; CSS pins visual size so layout
      // math in positionOverlayAtPct (offsetWidth) stays predictable.
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      scrubPreview.width = Math.round(PREVIEW_WIDTH * dpr);
      scrubPreview.height = Math.round(dispH * dpr);
      scrubPreview.style.width = PREVIEW_WIDTH + "px";
      scrubPreview.style.height = dispH + "px";
      previewSized = true;
    }

    function captureFrameIfNeeded() {
      if (!SHOW_FRAME_PREVIEW) return;
      if (!video.videoWidth || !video.videoHeight) return;
      if (typeof createImageBitmap !== "function") return;
      const t = Math.floor(video.currentTime);
      if (t === lastCachedSec) return;
      if (frameCache.has(t)) { lastCachedSec = t; return; }
      lastCachedSec = t;
      ensurePreviewSized();
      createImageBitmap(video, {
        resizeWidth: PREVIEW_WIDTH,
        resizeHeight: scrubPreview.height,
        resizeQuality: "low",
      })
        .then(bmp => {
          if (frameCache.size >= PREVIEW_MAX_FRAMES) {
            const oldest = frameCache.keys().next().value;
            const old = frameCache.get(oldest);
            if (old && old.close) old.close();
            frameCache.delete(oldest);
          }
          frameCache.set(t, bmp);
          if (lastHoverSec >= 0) drawPreviewAt(lastHoverSec);
        })
        .catch(() => {});
    }

    function drawPreviewAt(hoverSec) {
      if (!SHOW_FRAME_PREVIEW) return;
      ensurePreviewSized();
      if (frameCache.size === 0) return;
      const target = Math.floor(hoverSec);
      let bestKey = -1;
      let bestDist = Infinity;
      for (const k of frameCache.keys()) {
        const d = Math.abs(k - target);
        if (d < bestDist) { bestDist = d; bestKey = k; }
      }
      const bmp = frameCache.get(bestKey);
      if (!bmp) return;
      scrubPreviewCtx.clearRect(0, 0, scrubPreview.width, scrubPreview.height);
      scrubPreviewCtx.drawImage(bmp, 0, 0, scrubPreview.width, scrubPreview.height);
    }

    function updateScrubLabel(clientX) {
      const r = scrubber.getBoundingClientRect();
      if (r.width <= 0) return;
      const pct = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
      const dur = video.duration;
      if (!isFinite(dur) || dur <= 0) return;
      const hoverSec = pct * dur;
      const cur = fmtTime(hoverSec);
      scrubLabel.textContent = (SHOW_TOTAL_TIME || SHOW_FRAME_PREVIEW)
        ? `${cur} / ${fmtTime(dur)}` : cur;
      positionOverlayAtPct(scrubLabel, pct, r.width);
      if (SHOW_FRAME_PREVIEW) {
        positionOverlayAtPct(scrubPreview, pct, r.width);
        lastHoverSec = hoverSec;
        drawPreviewAt(hoverSec);
      }
    }

    let scrubDragging = false;

    function onScrubPointerDown(e) {
      if (e.button != null && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      scrubDragging = true;
      scrubber.classList.add("dragging");
      // Guarded on boostMode so a drag-end doesn't unhide chrome that boost
      // is still managing.
      const draggedHideChrome = !boostMode;
      if (draggedHideChrome) hideChrome();
      seekFromClientX(e.clientX, true);
      updateScrubLabel(e.clientX);

      function onMove(ev) {
        seekFromClientX(ev.clientX, true);
        updateScrubLabel(ev.clientX);
      }
      function onUp() {
        scrubDragging = false;
        scrubber.classList.remove("dragging");
        if (draggedHideChrome && !boostMode) showChrome();
        document.removeEventListener("pointermove", onMove, true);
        document.removeEventListener("pointerup", onUp, true);
        document.removeEventListener("pointercancel", onUp, true);
      }
      document.addEventListener("pointermove", onMove, true);
      document.addEventListener("pointerup", onUp, true);
      document.addEventListener("pointercancel", onUp, true);
    }

    function onScrubHoverMove(e) {
      if (scrubDragging) return;
      updateScrubLabel(e.clientX);
    }

    scrubber.addEventListener("pointerdown", onScrubPointerDown);
    scrubber.addEventListener("pointermove", onScrubHoverMove);
    video.addEventListener("timeupdate", syncScrubberFromVideo);
    video.addEventListener("loadedmetadata", syncScrubberFromVideo);
    video.addEventListener("durationchange", syncScrubberFromVideo);
    if (SHOW_FRAME_PREVIEW) {
      video.addEventListener("timeupdate", captureFrameIfNeeded);
      // `seeked` is what catches drag-scrubbing: setting currentTime on a
      // paused video doesn't reliably fire timeupdate but always fires seeked.
      video.addEventListener("seeked", captureFrameIfNeeded);
      video.addEventListener("loadedmetadata", () => {
        previewSized = false;
        ensurePreviewSized();
        captureFrameIfNeeded();
      });
    }

    document.body.appendChild(host);
    updatePosition();
    setRate(1);

    // Settle burst. On Reels (and Explore's single-video view), the <video>
    // can be mounted and laid out before IG's transparent click-catcher
    // overlays finish hydrating around it. During that window, isVideoVisible
    // returns false (elementFromPoint at center returns an element that
    // doesn't match any of our heuristics yet), so the host hides itself.
    //
    // None of our event-based re-check triggers (scroll, window resize,
    // body-child mutation, video resize) fire on a settled Reels page —
    // there's nothing to scroll and the video is already at final size — so
    // without this burst the pill stays hidden until the user refreshes and
    // wins the race. Re-run updatePosition every animation frame for ~1s,
    // stopping once the host becomes visible. Trivial cost on Home (first
    // frame already passes, burst exits immediately).
    let alive = true;
    let settleFrames = 60;
    function settle() {
      if (!alive) return;
      updatePosition();
      if (host.style.display !== "none") return;
      if (--settleFrames <= 0) return;
      requestAnimationFrame(settle);
    }
    requestAnimationFrame(settle);

    // Step ±1 preset; if current rate isn't on a preset, snap to nearest first.
    function cycleSpeed(delta) {
      const cur = video.playbackRate;
      let idx = SPEED_PRESETS.indexOf(cur);
      if (idx === -1) {
        let nearest = 0, nd = Infinity;
        for (let i = 0; i < SPEED_PRESETS.length; i++) {
          const d = Math.abs(SPEED_PRESETS[i] - cur);
          if (d < nd) { nd = d; nearest = i; }
        }
        idx = nearest;
      }
      const ni = Math.max(0, Math.min(SPEED_PRESETS.length - 1, idx + delta));
      setRate(SPEED_PRESETS[ni]);
    }

    return {
      updatePosition,
      // Public surface for the document-level keyboard handler.
      skipBy,
      enterBoost,
      exitBoost,
      cycleSpeed,
      resetSpeed() { setRate(1); },
      cleanup() {
        alive = false;
        if (promotedSkipTeardown) promotedSkipTeardown();
        autoAdvanceListeners.delete(renderAutoToggle);
        video.removeEventListener("timeupdate", onAutoAdvanceTimeupdate);
        video.removeEventListener("play", onAutoAdvanceReset);
        video.removeEventListener("loadstart", onAutoAdvanceReset);
        video.removeEventListener("emptied", onAutoAdvanceReset);
        if (boostHoldTimer) clearTimeout(boostHoldTimer);
        if (skipBadgeTimer) clearTimeout(skipBadgeTimer);
        if (reverseHandle) {
          if (useVFC) video.cancelVideoFrameCallback(reverseHandle);
          else cancelAnimationFrame(reverseHandle);
        }
        if (hiddenChrome.length) showChrome();
        video.removeEventListener("pause", onBoostPauseFight);
        document.removeEventListener("pointerdown", onDocDownDebug, true);
        document.removeEventListener("pointerdown", onDocDown, true);
        window.removeEventListener("pointerdown", onZoneDocDown, true);
        document.removeEventListener("pointermove", onDragMove);
        document.removeEventListener("pointerup", onDragUp, true);
        clearZoneDown();
        document.removeEventListener("scroll", updatePosition, true);
        window.removeEventListener("resize", updatePosition);
        video.removeEventListener("loadedmetadata", updatePosition);
        video.removeEventListener("resize", updatePosition);
        ro.disconnect();
        // Home-feed virtualization churns through videos — release bitmaps.
        for (const bmp of frameCache.values()) {
          if (bmp && bmp.close) bmp.close();
        }
        frameCache.clear();
        host.remove();
      },
    };
  }

  // Re-run updatePosition on every mounted pill, batched per animation frame.
  // Called from the DOM MutationObserver so modal open/close (which doesn't
  // fire scroll/resize) refreshes occlusion checks on stale pills.
  let updateScheduled = false;
  function scheduleVisibilityUpdate() {
    if (updateScheduled) return;
    updateScheduled = true;
    requestAnimationFrame(() => {
      updateScheduled = false;
      videos.forEach((v) => {
        const u = uiByVideo.get(v);
        if (u && u.updatePosition) u.updatePosition();
      });
    });
  }

  function track(video) {
    // If the attribute is set but we don't have UI for this element (e.g.
    // IG reused the element across an SPA route change without firing a
    // proper unmount), force a re-track instead of bailing.
    if (video.hasAttribute(TRACKED_ATTR)) {
      if (videos.has(video) && uiByVideo.has(video)) {
        return;
      }
      dlog("[Maestro] track: stale TRACKED_ATTR on reused element — re-tracking", video);
      video.removeAttribute(TRACKED_ATTR);
    }
    if (isStoriesPage()) return;
    video.setAttribute(TRACKED_ATTR, "true");
    videos.add(video);
    const ui = mountSpeedUI(video);
    if (ui) uiByVideo.set(video, ui);
    dlog("[Maestro] video found", video, `(tracked: ${videos.size}, url: ${location.pathname})`);
  }

  function untrack(video) {
    if (!videos.has(video)) {
      // Element might be in DOM as the same instance across SPA routes —
      // clear the attribute so a subsequent track() can re-mount UI on it.
      if (video.hasAttribute(TRACKED_ATTR)) video.removeAttribute(TRACKED_ATTR);
      return;
    }
    videos.delete(video);
    const ui = uiByVideo.get(video);
    if (ui) {
      ui.cleanup();
      uiByVideo.delete(video);
    }
    // Always clear the attribute so a re-insertion of the same element
    // (which IG/React can do during SPA navigation) gets freshly tracked.
    if (video.hasAttribute(TRACKED_ATTR)) video.removeAttribute(TRACKED_ATTR);
    dlog("[Maestro] video removed", video, `(tracked: ${videos.size}, url: ${location.pathname})`);
  }

  /** Find every <video> in a subtree (including the root itself). */
  function forEachVideo(root, fn) {
    if (root instanceof HTMLVideoElement) {
      fn(root);
    } else if (root.querySelectorAll) {
      root.querySelectorAll("video").forEach(fn);
    }
  }

  // Catch videos already in the DOM when the script runs.
  forEachVideo(document, track);

  // Instagram is an SPA: videos mount and unmount constantly as you scroll
  // and navigate. Watch the whole document for added/removed nodes.
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      m.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) forEachVideo(node, track);
      });
      m.removedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) forEachVideo(node, untrack);
      });
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  // Narrow observer: only watches direct children of <body>, where IG mounts
  // modal/dialog portals. Fires far less often than the document-wide observer
  // above, so it's safe to refresh every mounted pill's visibility here.
  const bodyChildObserver = new MutationObserver(scheduleVisibilityUpdate);
  bodyChildObserver.observe(document.body, { childList: true });

  // IG's in-Reels popups (Comment, Share, More, etc.) mount their
  // [role="dialog"] panels deeper than <body>'s direct children, so
  // bodyChildObserver misses their open/close. Catch them via:
  //   - popstate: IG pushes/pops history state when opening/closing these
  //     panels, so this fires on close.
  //   - attribute observer on existing dialogs: when IG toggles a dialog
  //     via aria-hidden / display:none rather than removing it from the
  //     DOM, our isBlockedByOtherModal rect check needs to be re-evaluated.
  // On every SPA route change (popstate fires on back/forward + IG often
  // dispatches it on pushState too), re-scan the DOM for any <video> elements
  // we might've missed. Cheap (querySelectorAll('video') on a single page).
  function rescanVideos() {
    forEachVideo(document, track);
    scheduleVisibilityUpdate();
  }
  window.addEventListener("popstate", rescanVideos);
  // Also rescan after navigation by intercepting pushState/replaceState,
  // since they don't fire popstate but DO indicate SPA navigation.
  const origPush = history.pushState;
  const origReplace = history.replaceState;
  history.pushState = function (...args) {
    const ret = origPush.apply(this, args);
    queueMicrotask(rescanVideos);
    return ret;
  };
  history.replaceState = function (...args) {
    const ret = origReplace.apply(this, args);
    queueMicrotask(rescanVideos);
    return ret;
  };

  // Targeted dialog observer: refresh visibility whenever any
  // [role="dialog"] mounts or unmounts anywhere, OR has its attributes
  // toggled. Scoped narrowly (we only watch dialog elements as they appear)
  // to keep work cheap.
  const dialogObserver = new MutationObserver(scheduleVisibilityUpdate);
  function watchExistingDialogs() {
    for (const d of document.querySelectorAll('[role="dialog"]')) {
      dialogObserver.observe(d, { attributes: true, attributeFilter: ["aria-hidden", "style", "class"] });
    }
  }
  watchExistingDialogs();
  // Re-watch when new dialogs appear (cheap — the document-wide observer
  // already runs on every DOM change for video detection; piggyback here).
  const dialogMountObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (node.matches && node.matches('[role="dialog"]')) {
          dialogObserver.observe(node, { attributes: true, attributeFilter: ["aria-hidden", "style", "class"] });
          scheduleVisibilityUpdate();
        } else if (node.querySelectorAll) {
          for (const d of node.querySelectorAll('[role="dialog"]')) {
            dialogObserver.observe(d, { attributes: true, attributeFilter: ["aria-hidden", "style", "class"] });
            scheduleVisibilityUpdate();
          }
        }
      }
      // Also catch removal of any dialog → re-check visibility.
      for (const node of m.removedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if ((node.matches && node.matches('[role="dialog"]')) ||
            (node.querySelector && node.querySelector('[role="dialog"]'))) {
          scheduleVisibilityUpdate();
        }
      }
    }
  });
  dialogMountObserver.observe(document.documentElement, { childList: true, subtree: true });

  // Keyboard shortcuts. Target the tracked video closest to viewport center.
  //   J / K              tap = skip ±5s, hold = 2× reverse / forward boost
  //   Shift+J / Shift+K  skip ±10s
  //   U / I              cycle speed preset down/up
  //   M                  open Instagram messages (claims the key from IG's M)
  //   O                  mute / unmute
  //   R                  reset speed to 1×
  //   A                  toggle auto-advance (Reels feed only)
  const KEY_HOLD_THRESHOLD_MS = 250;
  let activeKeyHold = null;

  function isTypingInInput() {
    const el = document.activeElement;
    if (!el) return false;
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return true;
    return !!el.isContentEditable;
  }

  function findKeyboardTargetVideo() {
    if (videos.size === 0) return null;
    if (videos.size === 1) return videos.values().next().value;
    const vw = window.innerWidth, vh = window.innerHeight;
    const cx = vw / 2, cy = vh / 2;
    let best = null, bestDist = Infinity;
    for (const v of videos) {
      const r = v.getBoundingClientRect();
      if (r.width <= 0 || r.bottom <= 0 || r.top >= vh) continue;
      const dx = (r.left + r.width / 2) - cx;
      const dy = (r.top + r.height / 2) - cy;
      const d = dx * dx + dy * dy;
      if (d < bestDist) { bestDist = d; best = v; }
    }
    return best;
  }

  // Open Instagram's DM inbox. Prefer clicking IG's own messages nav link so it
  // stays an SPA navigation (app state preserved); the link is the nav anchor to
  // /direct/inbox/. Fall back to the messages nav icon by aria-label (locale
  // varies — "Messenger" / "Direct"), then to a plain navigation if neither is
  // mounted (e.g. a collapsed nav).
  function openIGMessages() {
    let link = document.querySelector('a[href="/direct/inbox/"]');
    if (!link) {
      const icon = document.querySelector(
        'svg[aria-label="Messenger" i], svg[aria-label*="Direct" i]'
      );
      if (icon) link = icon.closest('a, [role="link"], [role="button"]');
    }
    if (link) {
      link.click();
      dlog("[Maestro] M → opened messages via IG nav", link);
      return;
    }
    dlog("[Maestro] M → no nav link found; navigating to /direct/inbox/");
    location.assign("/direct/inbox/");
  }

  function onMaestroKeyDown(e) {
    // Per-press M diagnostics: logs every M keydown that reaches us, plus the
    // state of each guard, so the console shows whether the key was received
    // and — if it bails — why. NO "[Maestro] M keydown seen" line at all means
    // the event never reached us (IG or focus is eating it before we run).
    if (DEBUG && (e.key || "").toLowerCase() === "m") {
      const tgt = findKeyboardTargetVideo();
      dlog(
        "[Maestro] M keydown seen —",
        "repeat:", e.repeat,
        "modifier:", e.ctrlKey || e.metaKey || e.altKey,
        "typingInInput:", isTypingInInput(),
        "targetVideo:", !!tgt,
        "hasHandle:", !!(tgt && uiByVideo.get(tgt)),
        "activeElement:", document.activeElement && document.activeElement.tagName
      );
    }
    if (e.repeat) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTypingInInput()) return;

    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;

    // M → open Instagram messages. Global: works anywhere on IG, so it doesn't
    // need a target video — handled before the video gate. Claim the key so
    // IG's native M (mute) can't also fire.
    if (k === "m") {
      e.preventDefault();
      e.stopImmediatePropagation();
      openIGMessages();
      return;
    }

    const video = findKeyboardTargetVideo();
    if (!video) return;
    const handle = uiByVideo.get(video);
    if (!handle) return;

    switch (k) {
      // Speed preset cycle down / up. e.key (the letter) is fine here —
      // unlike the old , / . binding there's no layout-specific punctuation.
      case "u": e.preventDefault(); handle.cycleSpeed(-1); break;
      case "i": e.preventDefault(); handle.cycleSpeed(+1); break;
      // Skip / boost. tap = skip ±5s, Shift+ = skip ±10s, hold = 2× boost.
      case "j":
        e.preventDefault();
        if (e.shiftKey) { handle.skipBy(-10); return; }
        if (activeKeyHold) return;
        activeKeyHold = {
          key: "j", video, committed: null,
          holdTimer: setTimeout(() => {
            if (!activeKeyHold || activeKeyHold.committed) return;
            activeKeyHold.committed = "hold";
            handle.enterBoost("rev");
          }, KEY_HOLD_THRESHOLD_MS),
        };
        break;
      case "k":
        e.preventDefault();
        if (e.shiftKey) { handle.skipBy(10); return; }
        if (activeKeyHold) return;
        activeKeyHold = {
          key: "k", video, committed: null,
          holdTimer: setTimeout(() => {
            if (!activeKeyHold || activeKeyHold.committed) return;
            activeKeyHold.committed = "hold";
            handle.enterBoost("fwd");
          }, KEY_HOLD_THRESHOLD_MS),
        };
        break;
      // Mute toggle — moved off M (which now opens messages). CLICK IG's own
      // mute button so IG flips its state AND its speaker icon (writing
      // video.muted directly mutes audio but leaves IG's glyph stale). Claim the
      // key so nothing else fires. Fall back to a direct mute if the button
      // isn't in the DOM.
      case "o": {
        e.preventDefault();
        e.stopImmediatePropagation();
        const muteBtn = findIGMuteButton(video);
        if (muteBtn) {
          muteBtn.click();
          dlog("[Maestro] mute via O → clicked IG audio button", muteBtn);
        } else {
          video.muted = !video.muted;
          dlog("[Maestro] mute via O → no IG button found; set video.muted =", video.muted);
        }
        break;
      }
      case "r": e.preventDefault(); handle.resetSpeed(); break;
      // Auto-advance toggle (Reels only). Flips the same global setting as the
      // rail button, so the visible toggle re-renders + pops. Claim the key from
      // IG only when we actually act (on the Reels feed); elsewhere leave A be.
      case "a":
        if (!isReelsFeedPage()) break;
        e.preventDefault();
        e.stopImmediatePropagation();
        setAutoAdvance(!autoAdvanceEnabled);
        dlog("[Maestro] auto-advance toggled via A →", autoAdvanceEnabled ? "ON" : "OFF");
        break;
    }
  }

  function onMaestroKeyUp(e) {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    // We claim M on keydown (to open messages); swallow its keyup too so IG's
    // native mute can't fire on release (IG binds one phase or the other).
    if (k === "m" && !isTypingInInput()) {
      dlog("[Maestro] M keyup swallowed (blocking IG's native mute on release)");
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (!activeKeyHold) return;
    if (k !== activeKeyHold.key) return;
    const { committed, video, holdTimer, key } = activeKeyHold;
    clearTimeout(holdTimer);
    activeKeyHold = null;
    const handle = uiByVideo.get(video);
    if (!handle) return;
    if (committed === "hold") handle.exitBoost();
    else handle.skipBy(key === "j" ? -5 : 5);
  }

  // Tab-switch / alt-tab mid-hold won't fire keyup — release the boost
  // cleanly so playbackRate doesn't stick at 2×.
  function onMaestroBlur() {
    if (!activeKeyHold) return;
    if (activeKeyHold.committed === "hold") {
      const handle = uiByVideo.get(activeKeyHold.video);
      if (handle) handle.exitBoost();
    }
    clearTimeout(activeKeyHold.holdTimer);
    activeKeyHold = null;
  }

  window.addEventListener("keydown", onMaestroKeyDown, true);
  window.addEventListener("keyup", onMaestroKeyUp, true);
  window.addEventListener("blur", onMaestroBlur);

  dlog("[Maestro] content script loaded — watching for videos.");
})();
