/**
 * presence.js — App-level presence manager for CampusConnect.
 *
 * Include AFTER socket.io.js on every authenticated page.
 *
 * Design principles:
 *  - Presence is APP-level, not route-level. Navigating from Explore to
 *    Messages to Profile should never make the user look offline.
 *  - The only signals that change presence are:
 *      · Tab becomes visible   → presence:active
 *      · Tab becomes hidden    → presence:inactive
 *      · Socket reconnect      → presence:active (if tab is visible)
 *      · Heartbeat every 25 s  → presence:heartbeat (keeps last_seen fresh)
 *      · Socket disconnect     → backend handles after 8 s grace period
 *  - We do NOT send any presence signal on beforeunload because that fires on
 *    every internal page navigation, causing false "offline" flickers. The
 *    backend's 8-second disconnect grace period covers genuine tab closes.
 *
 * Visibility rules (Page Visibility API + document.hasFocus):
 *  - document.visibilityState === 'visible'  → tab is foregrounded → active
 *  - document.visibilityState === 'hidden'   → tab is backgrounded → inactive
 *  - document.hasFocus() is used as a secondary check when the tab is visible
 *    but the window has no focus (e.g. another window is in front on the same
 *    monitor). We still treat this as active because the user can see the tab.
 */
(function () {
  'use strict';

  let sock           = null;
  let heartbeatTimer = null;
  let initialised    = false;  // guard: only register DOM listeners once

  // ── Presence signals ────────────────────────────────────────────────────

  function sendActive() {
    if (!sock || !sock.connected) return;
    sock.emit('presence:active');
    startHeartbeat();
  }

  function sendInactive() {
    stopHeartbeat();
    if (!sock || !sock.connected) return;
    sock.emit('presence:inactive');
  }

  // ── Heartbeat ────────────────────────────────────────────────────────────

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (document.visibilityState === 'visible' && sock && sock.connected) {
        sock.emit('presence:heartbeat');
      }
    }, 25000);
  }

  function stopHeartbeat() {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  // ── Visibility logic ─────────────────────────────────────────────────────

  /**
   * Returns true when the user should be considered active:
   *  - Tab is visible (primary signal — covers the "tab visible but another
   *    window has OS focus" case which is still active from app's perspective)
   */
  function isActive() {
    return document.visibilityState === 'visible';
  }

  // ── Initialisation ───────────────────────────────────────────────────────

  /**
   * Called once the socket is connected (or immediately if already connected).
   * Registers the visibilitychange listener exactly once regardless of how
   * many times the socket reconnects within a page.
   */
  function initPresence() {
    // Send initial state immediately based on current tab visibility
    if (isActive()) {
      sendActive();
    } else {
      sendInactive();
    }

    if (initialised) return;
    initialised = true;

    // React to tab show / hide (Page Visibility API)
    document.addEventListener('visibilitychange', () => {
      if (isActive()) {
        sendActive();
      } else {
        sendInactive();
      }
    });

    // Re-send active on socket reconnect (e.g. after brief network drop).
    // This fires AFTER the connection handler in socket.js has run, so
    // is_online is already TRUE — we just need to confirm is_active.
    sock.on('reconnect', () => {
      if (isActive()) sendActive();
    });

    // NOTE: No beforeunload listener. That event fires on every internal
    // navigation and would cause false "inactive" flickers. The backend's
    // 8-second disconnect grace period handles genuine tab closes cleanly.
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Call before logging out so the backend gets an immediate offline broadcast
   * instead of waiting for the 8-second disconnect grace period.
   * Usage: await window.ccPresence.logout()  (fire-and-forget is also fine)
   */
  window.ccPresence = {
    logout() {
      stopHeartbeat();
      return new Promise(resolve => {
        if (!sock || !sock.connected) { resolve(); return; }
        sock.emit('presence:logout');
        // Give the server a tick to process before the page unloads
        setTimeout(resolve, 150);
      });
    },
  };

  // ── Bootstrap ────────────────────────────────────────────────────────────

  function start() {
    try {
      // io() with no arguments returns the same socket instance when called
      // multiple times on the same page, so this never creates a duplicate
      // connection even though page scripts also call io().
      sock = io({ withCredentials: true });

      if (sock.connected) {
        initPresence();
      } else {
        sock.once('connect', initPresence);
      }
    } catch (e) {}
  }

  // Small timeout lets the page's own socket setup (presence:change listeners,
  // join:conv, etc.) complete first before we piggyback on the same socket.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(start, 0));
  } else {
    setTimeout(start, 0);
  }
})();
