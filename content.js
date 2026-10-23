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
    'music.youtube.com':   '#play-pause-button, .play-pause-button',
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
  // Scoped per-element (via WeakMap) plus a global timestamp guard to prevent
  // extension actions from ever being misattributed as manual user pauses.
  const _extActionTimers = new WeakMap(); // el -> timeoutId
  let _lastExtActionTime = 0;

  function markExtAction(el) {
    _lastExtActionTime = Date.now();
    if (!el) return;
    const existing = _extActionTimers.get(el);
    if (existing) clearTimeout(existing);
    el.__smtmExtAction = true;
    const timer = setTimeout(() => { el.__smtmExtAction = false; }, 2500);
    _extActionTimers.set(el, timer);
  }

  // detect when the user manually pauses/plays so background.js can back off
  const _watchedMedia = new WeakSet();

  function attachMediaListeners(el) {
    if (_watchedMedia.has(el)) return;
    _watchedMedia.add(el);
    el.addEventListener('pause', () => {
      // Must be an active user gesture on the page — ignore extension actions and background pauses
      if (el.__smtmExtAction || Date.now() - _lastExtActionTime < 2500 || !document.hasFocus()) return;
      chrome.runtime.sendMessage({ action: 'userManualPause' }).catch(() => {});
    });
    el.addEventListener('play', () => {
      if (el.__smtmExtAction || Date.now() - _lastExtActionTime < 2500 || !document.hasFocus()) return;
      chrome.runtime.sendMessage({ action: 'userManualPlay' }).catch(() => {});
    });
  }

  function getAllMediaElements(root = document) {
    const list = Array.from(root.querySelectorAll('video, audio'));
    try {
      const allNodes = root.querySelectorAll('*');
      for (let i = 0; i < allNodes.length; i++) {
        if (allNodes[i].shadowRoot) {
          list.push(...getAllMediaElements(allNodes[i].shadowRoot));
        }
      }
    } catch { /* ignore */ }
    return list;
  }

  function scanAndAttach() {
    getAllMediaElements().forEach(attachMediaListeners);
  }

  let _scanTimer = null;
  function scheduleScan() {
    if (_scanTimer) return;
    _scanTimer = setTimeout(() => {
      _scanTimer = null;
      scanAndAttach();
    }, 300);
  }

  scanAndAttach();
  // MutationObserver catches players that load after the page shell (most SPAs)
  new MutationObserver(scheduleScan).observe(document.documentElement, { childList: true, subtree: true });

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
    const all = getAllMediaElements();
    if (all.length === 0) return null;
    if (all.length === 1) return all[0];
    return all.reduce((best, el) => (scoreElement(el) > scoreElement(best) ? el : best), all[0]);
  }

  function fadeVolume(el, from, to, ms = 500) {
    return new Promise(resolve => {
      if (el.__fadeInterval) clearInterval(el.__fadeInterval);
      const steps = 20;
      const delta = (to - from) / steps;
      let step = 0;
      el.__fadeInterval = setInterval(() => {
        try {
          step++;
          el.volume = Math.max(0, Math.min(1, from + delta * step));
        } catch { /* ignore */ }
        if (step >= steps) {
          clearInterval(el.__fadeInterval);
          el.__fadeInterval = null;
          resolve();
        }
      }, ms / steps);
    });
  }

  function trySiteSpecificControl(action) {
    const hostname = location.hostname.replace(/^www\./, '');
    let selector = SITE_SELECTORS[hostname];
    if (!selector && (hostname === 'm.youtube.com' || hostname === 'youtu.be')) {
      selector = SITE_SELECTORS['youtube.com'];
    }
    if (!selector) return false;

    for (const sel of selector.split(',').map(s => s.trim())) {
      const btn = document.querySelector(sel);
      if (!btn) continue;

      const aria = (btn.getAttribute('aria-label') || '').trim().toLowerCase();
      const title = (btn.getAttribute('title') || '').trim().toLowerCase();
      const tooltip = (btn.getAttribute('data-title-no-tooltip') || '').trim().toLowerCase();

      const isPlaying =
        aria.startsWith('pause') ||
        title.startsWith('pause') ||
        tooltip === 'pause' ||
        btn.classList.contains('playing') ||
        btn.dataset.state === 'playing';

      if (action === 'pause' && isPlaying)  { markExtAction(findMediaElement()); btn.click(); return true; }
      if (action === 'play'  && !isPlaying) { markExtAction(findMediaElement()); btn.click(); return true; }
    }
    return false;
  }

  async function handleSiteSpecificAction(action, fadeAudio) {
    const el = findMediaElement();
    if (el) markExtAction(el);

    if (action === 'pause' && fadeAudio && el && el.volume > 0) {
      el.__smtmUserVolume = el.volume;
      await fadeVolume(el, el.volume, 0);
    }

    if (action === 'play' && fadeAudio && el) {
      const targetVolume = el.__smtmUserVolume !== undefined ? el.__smtmUserVolume : (el.volume || 1);
      try { el.volume = 0; } catch { /* ignore */ }
      const clicked = trySiteSpecificControl(action);
      if (clicked) {
        await fadeVolume(el, 0, targetVolume);
      } else {
        try { el.volume = targetVolume; } catch { /* ignore */ }
      }
      return clicked;
    }

    const clicked = trySiteSpecificControl(action);
    if (clicked && action === 'pause' && fadeAudio && el) {
      setTimeout(() => {
        if (el.paused && el.__smtmUserVolume !== undefined) {
          try { el.volume = el.__smtmUserVolume; } catch { /* ignore */ }
        }
      }, 300);
    } else if (clicked && action === 'play' && !fadeAudio && el) {
      if (el.__smtmUserVolume !== undefined && el.volume === 0) {
        try { el.volume = el.__smtmUserVolume; } catch { /* ignore */ }
      }
    }
    return clicked;
  }

  async function actOnMediaElement(el, action, fadeAudio) {
    markExtAction(el);
    _lastActedElement = el;

    // Preserve the user's actual volume level instead of blasting at 1.0 (100%)
    if (el.volume > 0) {
      el.__smtmUserVolume = el.volume;
    }
    const targetVolume = el.__smtmUserVolume !== undefined ? el.__smtmUserVolume : (el.volume || 1);

    if (action === 'pause') {
      if (fadeAudio && el.volume > 0) {
        await fadeVolume(el, el.volume, 0);
      }
      try { el.pause(); } catch { /* ignore */ }
      const all = getAllMediaElements();
      for (const other of all) {
        if (other !== el && !other.paused) {
          markExtAction(other);
          try { other.pause(); } catch { /* ignore */ }
        }
      }
      if (fadeAudio) {
        setTimeout(() => {
          if (el.paused) {
            try { el.volume = targetVolume; } catch { /* ignore */ }
          }
        }, 300);
      }
    } else {
      if (fadeAudio) {
        try { el.volume = 0; } catch { /* ignore */ }
        el.play().catch(() => {});
        await fadeVolume(el, 0, targetVolume);
      } else {
        if (el.__smtmUserVolume !== undefined && el.volume === 0) {
          try { el.volume = targetVolume; } catch { /* ignore */ }
        }
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

    (async () => {
      try {
        _lastExtActionTime = Date.now();
        const preEl = findMediaElement();
        if (preEl) markExtAction(preEl);

        const siteHandled = await handleSiteSpecificAction(action, !!fadeAudio);
        if (siteHandled) {
          _lastActedElement = findMediaElement();
          const confirmDelay = (action === 'pause' && fadeAudio) ? CONFIRM_DELAY_FADE_MS : CONFIRM_DELAY_MS;
          await new Promise(r => setTimeout(r, confirmDelay));
        } else {
          await runAction(action, !!fadeAudio);
        }

        const el = _lastActedElement || findMediaElement();
        let confirmed = null;
        if (el) confirmed = action === 'pause' ? el.paused === true : el.paused === false;
        sendResponse({ handled: true, confirmed });
      } catch (_err) {
        sendResponse({ handled: false, confirmed: null });
      }
    })();

    return true; // keep channel open for the async sendResponse
  });
})();