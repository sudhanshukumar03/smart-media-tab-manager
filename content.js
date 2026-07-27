// content.js — injected on demand by background.js when it needs to control a tab
// IIFE + guard stops double-injection from firing events twice or crashing on
// duplicate const declarations

(function () {
  if (window.__smtmLoaded) return;
  window.__smtmLoaded = true;

  // play/pause button selectors per site
  // if none match we fall back to the <audio>/<video> element directly
  const SITE_SELECTORS = {
    'open.spotify.com':    'button[data-testid="control-button-playpause"]',
    'soundcloud.com':      '.playControls__play',
    'music.amazon.com':    '.transport-button-play-pause',
    'tidal.com':           'button[data-test="play"]',
    'music.youtube.com':   '.play-pause-button',
    'pandora.com':         'button[data-qa="play_pause"]',
    'deezer.com':          'button[aria-label="Play"], button[aria-label="Pause"]',
    // indian platforms — fallback to media element if selector misses
    'gaana.com':           '.playbtn, button[aria-label="Play"], button[aria-label="Pause"]',
    'jiosaavn.com':        '.o-icon-play, button[aria-label="Play"], button[aria-label="Pause"]',
    'wynk.in':             'button[aria-label="Play"], button[aria-label="Pause"]',
    'hungama.com':         '.play-btn, button[aria-label="Play"], button[aria-label="Pause"]',
    'youtube.com':         'button.ytp-play-button',
    'udemy.com':           'button[data-purpose="play-button"], button.vjs-play-control',
    'coursera.org':        'button[data-testid="play-button"], button.c-play-control',
    'pluralsight.com':     'button[aria-label="Play"], button[aria-label="Pause"]',
    'frontendmasters.com': 'button.play-btn',
    'scrimba.com':         'button[aria-label="Play"], button[aria-label="Pause"]',
    'egghead.io':          'button[aria-label="Play"], button[aria-label="Pause"]',
  };

  // How long the confirmation check waits after acting, before reporting
  // back to background.js. A pause-with-fade genuinely takes ~500ms to
  // finish (volume ramps down, THEN el.pause() fires), so if we check at
  // the same 350ms mark used for a plain pause, we'll see el.paused===false
  // and wrongly report "unconfirmed" — which makes background.js fall back
  // to Layer 2 and hard-mute the tab mid-fade. Give faded pauses extra time.
  const CONFIRM_DELAY_MS       = 350;
  const CONFIRM_DELAY_FADE_MS  = 650; // fade (~500ms) + buffer

  // flag so media event listeners know when WE paused/played, not the user.
  // Scoped per-element (via WeakMap) rather than one global boolean, so acting
  // on one player can't mask a genuine user action on a different player that
  // happens to fire its pause/play event in the same ~800ms window.
  const _extActionTimers = new WeakMap(); // el -> timeoutId

  function markExtAction(el) {
    if (!el) return;
    const existing = _extActionTimers.get(el);
    if (existing) clearTimeout(existing);
    el.__smtmExtAction = true;
    // 800ms covers the button click + any site debounce
    const timer = setTimeout(() => { el.__smtmExtAction = false; }, 800);
    _extActionTimers.set(el, timer);
  }

  // detect when the user manually pauses/plays so background.js can back off
  const _watchedMedia = new WeakSet();

  function attachMediaListeners(el) {
    if (_watchedMedia.has(el)) return;
    _watchedMedia.add(el);
    el.addEventListener('pause', () => {
      if (el.__smtmExtAction) return;
      chrome.runtime.sendMessage({ action: 'userManualPause' }).catch(() => {});
    });
    el.addEventListener('play', () => {
      if (el.__smtmExtAction) return;
      chrome.runtime.sendMessage({ action: 'userManualPlay' }).catch(() => {});
    });
  }

  function scanAndAttach() {
    document.querySelectorAll('video, audio').forEach(attachMediaListeners);
  }

  scanAndAttach();
  // MutationObserver catches players that load after the page shell (most SPAs)
  new MutationObserver(scanAndAttach).observe(document.documentElement, { childList: true, subtree: true });

  // Remember the element we last acted on so the confirmation check inspects
  // the SAME element we just paused/played, instead of independently calling
  // findMediaElement() again — which could pick a different element if the
  // page's playing state changed in between (e.g. an ad started).
  let _lastActedElement = null;

  function scoreElement(el) {
    // Heuristic ranking used to pick the "main" player when several
    // <video>/<audio> elements exist (ads, autoplay-next thumbnails, etc.)
    let score = 0;
    if (!el.paused) score += 10;         // currently playing is the strongest signal
    if (!el.muted && el.volume > 0) score += 4;
    if (el.currentTime > 0) score += 2;  // has actually started, not just loaded
    if (el.duration > 30) score += 1;    // longer media is more likely the "real" content
    return score;
  }

  function findMediaElement() {
    const all = Array.from(document.querySelectorAll('video, audio'));
    if (all.length === 0) return null;
    if (all.length === 1) return all[0];
    return all.reduce((best, el) => (scoreElement(el) > scoreElement(best) ? el : best), all[0]);
  }

  function fadeVolume(el, from, to, ms = 500) {
    return new Promise(resolve => {
      const steps = 20;
      const delta = (to - from) / steps;
      let step = 0;
      const iv = setInterval(() => {
        step++;
        el.volume = Math.max(0, Math.min(1, from + delta * step));
        if (step >= steps) { clearInterval(iv); resolve(); }
      }, ms / steps);
    });
  }

  function trySiteSpecificControl(action) {
    const hostname = location.hostname.replace(/^www\./, '');
    const selector = SITE_SELECTORS[hostname];
    if (!selector) return false;

    for (const sel of selector.split(',').map(s => s.trim())) {
      const btn = document.querySelector(sel);
      if (!btn) continue;

      const isPlaying =
        btn.getAttribute('aria-label') === 'Pause' ||
        btn.classList.contains('playing') ||
        btn.dataset.state === 'playing';

      if (action === 'pause' && isPlaying)  { markExtAction(findMediaElement()); btn.click(); return true; }
      if (action === 'play'  && !isPlaying) { markExtAction(findMediaElement()); btn.click(); return true; }
    }
    return false;
  }

  async function actOnMediaElement(el, action, fadeAudio) {
    markExtAction(el);
    _lastActedElement = el;
    if (action === 'pause') {
      if (fadeAudio) {
        // Fade the audible volume down first so the pause doesn't sound like
        // an abrupt cut, THEN pause. This genuinely takes ~500ms — callers
        // must account for that when deciding how long to wait before
        // checking confirmation (see CONFIRM_DELAY_FADE_MS above).
        await fadeVolume(el, el.volume, 0);
      }
      el.pause();
      if (fadeAudio) el.volume = 1; // restore for next play
    } else {
      if (fadeAudio) {
        el.volume = 0;
        el.play().catch(() => {});
        await fadeVolume(el, 0, 1);
      } else {
        el.play().catch(() => {});
      }
    }
  }

  // SPAs often don't have a player ready when we first inject — poll up to 3s
  function waitForMediaAndAct(action, fadeAudio, resolve, start = Date.now()) {
    const el = findMediaElement();
    if (el) { actOnMediaElement(el, action, fadeAudio).then(resolve); return; }
    if (Date.now() - start > 3000) { resolve(); return; } // give up, Layer 2 handles it
    setTimeout(() => waitForMediaAndAct(action, fadeAudio, resolve, start), 300);
  }

  // Coalesce overlapping requests: if background.js's own retry logic (or a
  // second onMessage call) arrives while a previous act-on-media flow is
  // still in progress, wait for that one to settle instead of starting a
  // second concurrent poll/fade loop against the same element.
  let _pendingAction = null;

  function runAction(action, fadeAudio) {
    const start = _pendingAction
      ? _pendingAction.then(() => new Promise(resolve => waitForMediaAndAct(action, fadeAudio, resolve)))
      : new Promise(resolve => waitForMediaAndAct(action, fadeAudio, resolve));
    _pendingAction = start.finally(() => {
      if (_pendingAction === start) _pendingAction = null;
    });
    return _pendingAction;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const { action, fadeAudio } = message;

    if (action !== 'pause' && action !== 'play') {
      sendResponse({ handled: false, confirmed: null });
      return;
    }

    const siteHandled = trySiteSpecificControl(action);
    if (siteHandled) {
      _lastActedElement = findMediaElement();
    } else {
      runAction(action, !!fadeAudio);
    }

    // wait a beat then check if the media element is actually in the right
    // state — background.js uses this to decide whether Layer 2 mute is
    // needed. A faded pause needs longer before it settles into el.paused.
    const confirmDelay = (action === 'pause' && fadeAudio) ? CONFIRM_DELAY_FADE_MS : CONFIRM_DELAY_MS;

    setTimeout(() => {
      const el = _lastActedElement || findMediaElement();
      let confirmed = null;
      if (el) confirmed = action === 'pause' ? el.paused === true : el.paused === false;
      sendResponse({ handled: true, confirmed });
    }, confirmDelay);

    return true; // keep channel open for the async sendResponse
  });
})();