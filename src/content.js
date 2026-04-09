// Maestro — content script
// Phase 1: detect <video> elements and mount a speed-control pill onto each.
// Per-video scope — every newly mounted video starts at 1×.
//
// The pill is mounted as a direct child of <body> with position: fixed,
// anchored to the video's getBoundingClientRect(). This sidesteps IG's
// per-post click-catchers (notably on Reels) and stacking contexts.

(() => {
  "use strict";

  const TRACKED_ATTR = "data-Maestro-tracked";
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

  // User-tunable scrubber preferences (future settings UI will toggle these).
  const SHOW_FRAME_PREVIEW = false;
  // Forced on internally whenever SHOW_FRAME_PREVIEW is on.
  const SHOW_TOTAL_TIME = false;

  // Kept under ~500ms — IG sometimes auto-advances on its own after that
  // and our skip then fires into a different DOM.
  const PROMOTED_SKIP_DELAY_MIN_MS = 100;
  const PROMOTED_SKIP_DELAY_MAX_MS = 250;

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
  // element's height in flow so scroll-snap math (clickNextReel Strategy 2)
  // still computes correct viewport offsets — using `display: none` would
  // collapse the height and shift everything below it, potentially
  // confusing IG's carousel.
  //
  // muted + volume:0 belt-and-suspenders: setting both means even if IG
  // unmutes via DOM property or volume change as part of its playback
  // logic, the other one keeps the audio at 0. Practically: the user gets
  // no audio at all during the brief delay before scroll.
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
    }
  }

  // Advance the Reels feed past the current reel. Tries three strategies
  // in order — button click, scroll-snap by viewport, ArrowDown keydown —
  // because the next-reel button is only mounted while the user is hovering
  // the Reels area, so Strategy 1 silently fails when auto-skip fires
  // headlessly.
  function clickNextReel() {
    // Strategy 1: click the next-reel button. Works when the user's cursor
    // is over the Reels area (IG mounts the button on hover).
    const btn =
      document.querySelector('[aria-label="Navigate to next Reel"]') ||
      document.querySelector('[aria-label*="next reel" i]') ||
      document.querySelector('[aria-label*="next" i][role="button"]');
    if (btn) {
      dlog("[Maestro] promoted-skip: clicking next-reel button", btn);
      btn.click();
      return;
    }

    // Strategy 2: scroll the Reels carousel by one viewport. IG Reels uses
    // CSS scroll-snap, so scrolling by `clientHeight` snaps to the next
    // item. This works regardless of whether the user is hovering.
    const v = document.querySelector('video[data-Maestro-tracked]');
    if (v) {
      let cur = v.parentElement;
      while (cur && cur !== document.documentElement) {
        if (cur.scrollHeight > cur.clientHeight + 4) {
          const style = getComputedStyle(cur);
          if (style.overflowY === "auto" || style.overflowY === "scroll") {
            dlog("[Maestro] promoted-skip: scrolling reels container by", cur.clientHeight, "px", cur);
            cur.scrollBy(0, cur.clientHeight);
            return;
          }
        }
        cur = cur.parentElement;
      }
    }

    // Strategy 3: synthesize an ArrowDown keydown. IG binds arrow-key
    // navigation on the Reels page. Untrusted event but worth a shot —
    // last resort if no scroll container and no button.
    dlog("[Maestro] promoted-skip: dispatching ArrowDown keydown");
    document.dispatchEvent(new KeyboardEvent("keydown", {
      key: "ArrowDown",
      code: "ArrowDown",
      keyCode: 40,
      which: 40,
      bubbles: true,
      cancelable: true,
    }));
  }

  /** Live set of <video> elements Maestro currently knows about. */
  const videos = new Set();

  // Per-video UI handle so untrack() can fully tear it down.
  // WeakMap lets detached <video>s be GC'd if untrack ever misses one.
  const uiByVideo = new WeakMap();

  // Injected page-level stylesheet — used to hide IG's chrome (account info,
  // follow button, caption, mute) during a 2× boost. Lives outside our shadow
  // DOM because the elements we tag belong to IG, not us.
  const boostStyleTag = document.createElement("style");
  boostStyleTag.textContent = `
    .Maestro-boost-hidden {
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
    host.className = "Maestro-speed-host";
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
          width: 36px;
          height: 36px;
          font: 600 14px/1 "Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif;
          color: #fff;
          background: rgba(0, 0, 0, 0.5);
          border-radius: 18px;
          cursor: pointer;
          pointer-events: auto;
          user-select: none;
          overflow: hidden;
          transition: width 220ms cubic-bezier(0.4, 0, 0.2, 1);
        }
        .pill.open { width: 208px; }
        .pill .display {
          position: absolute;
          right: 0;
          top: 0;
          width: 36px;
          height: 36px;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .pill.open .display { opacity: 0; pointer-events: none; }
        .pill.shrink .display { font-size: 13px; }
        .pill.big .display { font-size: 16px; }
        .pill .display .x {
          font-size: 0.65em;
          opacity: 0.85;
          margin-left: 1px;
        }
        .pill .row {
          position: absolute;
          right: 0;
          top: 0;
          height: 36px;
          display: flex;
          align-items: center;
          padding: 0 4px;
          opacity: 0;
          pointer-events: none;
          transition: opacity 140ms ease 80ms;
          font-size: 12px;
        }
        .pill.open .row { opacity: 1; pointer-events: auto; }
        .pill .row button {
          border: 0;
          background: transparent;
          color: #fff;
          font: inherit;
          font-weight: 600;
          height: 28px;
          min-width: 30px;
          padding: 0 4px;
          border-radius: 14px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          white-space: nowrap;
        }
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
      </style>
      <div class="zone left"></div>
      <div class="zone right"></div>
      <div class="pill">
        <div class="row"></div>
        <div class="display"><span class="num"></span><span class="x">×</span></div>
      </div>
      <div class="boost-badge"></div>
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
      row.appendChild(btn);
      rowButtons.push(btn);
    }

    function setRate(r) {
      const prev = video.playbackRate;
      video.playbackRate = r;
      const s = String(r);
      pillNum.textContent = s;
      pill.classList.toggle("shrink", s.length >= 4);
      pill.classList.toggle("big", s.length === 1);
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
      hiddenChrome.forEach((el) => el.classList.add("Maestro-boost-hidden"));
      pill.classList.add("hidden");
      // Scrubber stays visible during skip/boost so the user can watch the
      // playhead jump on a skip and accelerate during 2× boost — it's the
      // most useful real-time feedback for the very controls that change
      // currentTime, so hiding it would defeat the purpose.
    }

    function showChrome() {
      hiddenChrome.forEach((el) => el.classList.remove("Maestro-boost-hidden"));
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

      if (DEBUG && lastVisibilityState !== "shown") {
        dlog("[Maestro debug] host SHOWN — rect:", rect, "URL:", location.pathname);
        lastVisibilityState = "shown";
      }
    }

    pill.addEventListener("pointerdown", onPillDown);
    document.addEventListener("pointerdown", onDocDown, true);

    const ro = new ResizeObserver(updatePosition);
    ro.observe(video);
    // Capture-phase so scrolls in any nested scroll container update us too.
    document.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
    // loadedmetadata: <video> first gets intrinsic dimensions.
    // "resize" on HTMLVideoElement: intrinsic size changed mid-playback.
    video.addEventListener("loadedmetadata", updatePosition);
    video.addEventListener("resize", updatePosition);

    // Auto-skip promoted reels.
    //
    // Why multiple triggers:
    //   - `play` fires when IG calls video.play() on this reel becoming the
    //     active item. But IG can call play() before our MutationObserver
    //     callback finishes attaching the listener — race we can lose.
    //   - `timeupdate` fires repeatedly during actual playback. Even if we
    //     missed `play`, the first timeupdate is a guaranteed catch-up.
    //   - Immediate check covers the case where the video is already mid-
    //     playback by the time we mount (e.g. SPA re-attach of a reused
    //     element).
    //
    // We also retry the detection a few times: when a reel first mounts,
    // IG sometimes hasn't yet populated the surrounding disclosure DOM
    // (the "Ad" badge text and ig_redirect link) inside the reel item.
    // The first timeupdate can land before the DOM is fully decorated, so
    // the second or third check catches it.
    if (AUTO_SKIP_PROMOTED && isReelsFeedPage()) {
      let promotedChecksLeft = 5;
      let promotedActionTaken = false;
      const maybeSkipPromoted = (trigger) => {
        if (promotedActionTaken || promotedChecksLeft-- <= 0) return;
        const isPromoted = isPromotedReel(video);
        dlog("[Maestro] promoted-skip check via", trigger, "isPromoted:", isPromoted, "checksLeft:", promotedChecksLeft, video);
        if (!isPromoted) return;
        promotedActionTaken = true;
        // Black out the promoted reel's container IMMEDIATELY so the user
        // doesn't see the content during the brief delay before we scroll
        // past it. visibility:hidden keeps the layout box so scroll-snap
        // math stays correct (see hidePromotedReel comment).
        hidePromotedReel(video);
        const delay = PROMOTED_SKIP_DELAY_MIN_MS +
          Math.random() * (PROMOTED_SKIP_DELAY_MAX_MS - PROMOTED_SKIP_DELAY_MIN_MS);
        dlog("[Maestro] promoted-skip: reel detected, skipping in", Math.round(delay), "ms", video);
        setTimeout(clickNextReel, delay);
      };
      video.addEventListener("play", () => maybeSkipPromoted("play"));
      video.addEventListener("timeupdate", () => maybeSkipPromoted("timeupdate"));
      if (!video.paused && video.currentTime > 0) maybeSkipPromoted("immediate");
      dlog("[Maestro] promoted-skip: hook attached for", video.src);
    }

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
  //   U / I              tap = skip ±5s, hold = 2× reverse / forward boost
  //   Shift+U / Shift+I  skip ±10s
  //   , / .              cycle speed preset down/up
  //   R                  reset speed to 1×
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

  function onMaestroKeyDown(e) {
    if (e.repeat) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTypingInInput()) return;
    const video = findKeyboardTargetVideo();
    if (!video) return;
    const handle = uiByVideo.get(video);
    if (!handle) return;

    // Speed preset cycle — match e.code so any keyboard layout works.
    if (e.code === "Comma") {
      e.preventDefault(); handle.cycleSpeed(-1); return;
    }
    if (e.code === "Period") {
      e.preventDefault(); handle.cycleSpeed(+1); return;
    }

    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    switch (k) {
      case "u":
        e.preventDefault();
        if (e.shiftKey) { handle.skipBy(-10); return; }
        if (activeKeyHold) return;
        activeKeyHold = {
          key: "u", video, committed: null,
          holdTimer: setTimeout(() => {
            if (!activeKeyHold || activeKeyHold.committed) return;
            activeKeyHold.committed = "hold";
            handle.enterBoost("rev");
          }, KEY_HOLD_THRESHOLD_MS),
        };
        break;
      case "i":
        e.preventDefault();
        if (e.shiftKey) { handle.skipBy(10); return; }
        if (activeKeyHold) return;
        activeKeyHold = {
          key: "i", video, committed: null,
          holdTimer: setTimeout(() => {
            if (!activeKeyHold || activeKeyHold.committed) return;
            activeKeyHold.committed = "hold";
            handle.enterBoost("fwd");
          }, KEY_HOLD_THRESHOLD_MS),
        };
        break;
      case "r": e.preventDefault(); handle.resetSpeed(); break;
    }
  }

  function onMaestroKeyUp(e) {
    if (!activeKeyHold) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (k !== activeKeyHold.key) return;
    const { committed, video, holdTimer, key } = activeKeyHold;
    clearTimeout(holdTimer);
    activeKeyHold = null;
    const handle = uiByVideo.get(video);
    if (!handle) return;
    if (committed === "hold") handle.exitBoost();
    else handle.skipBy(key === "u" ? -5 : 5);
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
