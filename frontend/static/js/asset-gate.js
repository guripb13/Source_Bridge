(() => {
  const MIN_SAMPLE_BYTES = 32 * 1024;
  const MIN_SAMPLE_DURATION_MS = 500;
  const LOW_SPEED_BYTES_PER_SECOND = 125000; // 1 Mbps
  const failedAssets = new Set();
  const currentScript = document.currentScript;
  const startup = () => document.getElementById("assetStartup");
  const message = () => document.getElementById("assetStartupMessage");
  let appReady = false;
  let slowConnection = false;
  let resourceObserver = null;

  function updateSpeedEstimate() {
    const assets = performance.getEntriesByType("resource").filter(entry => {
      const url = new URL(entry.name, window.location.href);
      return url.origin === window.location.origin &&
        url.pathname.includes("/static/") &&
        entry.transferSize > 0 &&
        entry.responseEnd > entry.responseStart;
    });
    if (assets.length === 0) return;

    const bytes = assets.reduce((total, entry) => total + entry.transferSize, 0);
    const start = Math.min(...assets.map(entry => entry.responseStart));
    const end = Math.max(...assets.map(entry => entry.responseEnd));
    const duration = end - start;

    if (bytes < MIN_SAMPLE_BYTES || duration < MIN_SAMPLE_DURATION_MS) return;

    slowConnection = bytes * 1000 / duration < LOW_SPEED_BYTES_PER_SECOND;
    startup()?.classList.toggle("asset-startup-slow", slowConnection);
  }

  function recordAssetError(event) {
    const target = event.target;
    if (
      target instanceof HTMLLinkElement ||
      target instanceof HTMLScriptElement && target !== currentScript ||
      target instanceof HTMLImageElement
    ) {
      const url = target.href || target.src;
      if (url) failedAssets.add(url);
    } else if (event.filename) {
      failedAssets.add(event.filename);
    }
  }

  function cleanRetryParameter(url) {
    url.searchParams.delete("asset-retry");
    return url;
  }

  document.addEventListener("sb:app-ready", () => {
    appReady = true;
  }, { once: true });

  window.addEventListener("error", recordAssetError, true);
  if ("PerformanceObserver" in window) {
    resourceObserver = new PerformanceObserver(updateSpeedEstimate);
    resourceObserver.observe({ entryTypes: ["resource"] });
  }
  updateSpeedEstimate();
  document.addEventListener("DOMContentLoaded", () => {
    startup()?.classList.toggle("asset-startup-slow", slowConnection);
  }, { once: true });

  window.addEventListener("load", async () => {
    updateSpeedEstimate();
    await document.fonts.ready;
    resourceObserver?.disconnect();

    if (appReady && failedAssets.size === 0) {
      startup().hidden = true;
      const url = new URL(window.location.href);
      if (url.searchParams.has("asset-retry")) {
        window.history.replaceState(null, "", cleanRetryParameter(url));
      }
      return;
    }

    const url = new URL(window.location.href);
    const alreadyRetried = url.searchParams.get("asset-retry") === "1";
    if (!alreadyRetried) {
      await Promise.allSettled(Array.from(failedAssets, assetUrl =>
        fetch(assetUrl, { cache: "reload", credentials: "same-origin" })
      ));
      url.searchParams.set("asset-retry", "1");
      window.location.replace(url.href);
      return;
    }

    message().textContent = "Please wait or refresh";
    startup().classList.add("asset-startup-failed");
  }, { once: true });
})();
