// Scrub — content script
// Phase 1: detect <video> elements and mount a speed-control pill onto each.
// Per-video scope — every newly mounted video starts at 1×.
//
// The pill is mounted as a direct child of <body> with position: fixed,
// anchored to the video's getBoundingClientRect(). This sidesteps IG's
// per-post click-catchers (notably on Reels) and stacking contexts.

(() => {
  "use strict";

  const TRACKED_ATTR = "data-scrub-tracked";
  const SPEED_PRESETS = [0.5, 1, 1.25, 1.5, 1.75, 2];

  /** Live set of <video> elements Scrub currently knows about. */
  const videos = new Set();

  // Per-video UI handle so untrack() can fully tear it down.
  // WeakMap lets detached <video>s be GC'd if untrack ever misses one.
  const uiByVideo = new WeakMap();

  function formatRate(r) {
    return `${r}×`;
  }

  function mountSpeedUI(video) {
    const host = document.createElement("div");
    host.className = "scrub-speed-host";
    // Sized + positioned to match the video; pill/menu are absolute inside.
    // pointer-events: none on the host so clicks pass through to IG except
    // where the pill/menu set pointer-events: auto.
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
          font: 600 12px/1 "Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif;
          color: #fff;
          background: rgba(0, 0, 0, 0.72);
          padding: 5px 9px;
          border-radius: 12px;
          cursor: pointer;
          pointer-events: auto;
          user-select: none;
        }
        .menu {
          display: none;
          position: absolute;
          top: 36px;
          right: 8px;
          background: rgba(0, 0, 0, 0.85);
          border-radius: 6px;
          padding: 4px 0;
          pointer-events: auto;
          min-width: 64px;
        }
        .menu.open { display: block; }
        .menu button {
          display: block;
          width: 100%;
          padding: 6px 14px;
          border: 0;
          background: transparent;
          font: 500 12px/1 "Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif;
          color: #fff;
          cursor: pointer;
          text-align: left;
        }
        .menu button:hover { background: rgba(255, 255, 255, 0.14); }
        .menu button.active { color: #4ab3ff; font-weight: 700; }
      </style>
      <div class="pill"></div>
      <div class="menu"></div>
    `;

    const pill = shadow.querySelector(".pill");
    const menu = shadow.querySelector(".menu");

    for (const rate of SPEED_PRESETS) {
      const btn = document.createElement("button");
      btn.dataset.rate = String(rate);
      btn.textContent = formatRate(rate);
      menu.appendChild(btn);
    }

    function setRate(r) {
      video.playbackRate = r;
      pill.textContent = formatRate(r);
      menu.querySelectorAll("button").forEach((b) => {
        b.classList.toggle("active", Number(b.dataset.rate) === r);
      });
    }

    function setMenuOpen(open) {
      menu.classList.toggle("open", open);
    }

    // We handle pointerdown rather than click because IG (especially on Reels)
    // has a capture-phase click handler we can't outrun by registration order.
    // preventDefault() on pointerdown blocks the synthesized mousedown/click
    // entirely, so IG's tap-to-pause never gets a click to react to.
    function onPillDown(e) {
      e.preventDefault();
      e.stopPropagation();
      setMenuOpen(!menu.classList.contains("open"));
    }

    function onMenuDown(e) {
      e.preventDefault();
      e.stopPropagation();
      const btn = e.target.closest("button[data-rate]");
      if (!btn) return;
      setRate(Number(btn.dataset.rate));
      setMenuOpen(false);
    }

    // Close the menu on any pointerdown outside our host. Capture phase so we
    // see the event before any IG handlers that might also fire on it.
    function onDocDown(e) {
      if (!host.contains(e.target)) setMenuOpen(false);
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

    // Keep the host glued to the video as IG scrolls/resizes/swipes. We hide
    // the host entirely when the video is off-screen or occluded so the pill
    // doesn't sit on top of unrelated content.
    function updatePosition() {
      const rect = video.getBoundingClientRect();
      if (!isVideoVisible(rect)) {
        host.style.display = "none";
        setMenuOpen(false);
        return;
      }
      host.style.display = "block";
      host.style.left = `${rect.left}px`;
      host.style.top = `${rect.top}px`;
      host.style.width = `${rect.width}px`;
      host.style.height = `${rect.height}px`;

      const offset = headerOverlapPx(rect);
      pill.style.top = `${8 + offset}px`;
      menu.style.top = `${36 + offset}px`;
    }

    pill.addEventListener("pointerdown", onPillDown);
    menu.addEventListener("pointerdown", onMenuDown);
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

    return {
      updatePosition,
      cleanup() {
        alive = false;
        document.removeEventListener("pointerdown", onDocDown, true);
        document.removeEventListener("scroll", updatePosition, true);
        window.removeEventListener("resize", updatePosition);
        video.removeEventListener("loadedmetadata", updatePosition);
        video.removeEventListener("resize", updatePosition);
        ro.disconnect();
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
    if (video.hasAttribute(TRACKED_ATTR)) return;
    video.setAttribute(TRACKED_ATTR, "true");
    videos.add(video);
    const ui = mountSpeedUI(video);
    if (ui) uiByVideo.set(video, ui);
    console.debug("[Scrub] video found", video, `(tracked: ${videos.size})`);
  }

  function untrack(video) {
    if (!videos.has(video)) return;
    videos.delete(video);
    const ui = uiByVideo.get(video);
    if (ui) {
      ui.cleanup();
      uiByVideo.delete(video);
    }
    console.debug("[Scrub] video removed", video, `(tracked: ${videos.size})`);
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

  console.info("[Scrub] content script loaded — watching for videos.");
})();
