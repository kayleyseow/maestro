// Scrub — content script
// Phase 0: locate Instagram <video> elements and keep a live registry of them.
// No UI yet — Phase 1 mounts the speed control and scrubber onto tracked videos.

(() => {
  "use strict";

  // Marks a <video> we've already seen, so re-scans don't double-count it.
  const TRACKED_ATTR = "data-scrub-tracked";

  /** Live set of <video> elements Scrub currently knows about. */
  const videos = new Set();

  function track(video) {
    if (video.hasAttribute(TRACKED_ATTR)) return;
    video.setAttribute(TRACKED_ATTR, "true");
    videos.add(video);
    console.debug("[Scrub] video found", video, `(tracked: ${videos.size})`);
    // Phase 1: mount speed + scrubber UI (Shadow DOM) here.
  }

  function untrack(video) {
    if (!videos.has(video)) return;
    videos.delete(video);
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

  console.info("[Scrub] content script loaded — watching for videos.");
})();
