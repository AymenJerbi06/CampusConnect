// Shared badge refresh — include on every authenticated page
// Polls every 5 s; also called directly after any relevant action.

let _prevReqCount = -1;
let _prevMsgCount = -1;
let _badgeInterval = null;

async function refreshBadges() {
  try {
    const [reqRes, msgRes] = await Promise.all([
      fetch('/api/friends/requests', { credentials: 'include' }),
      fetch('/api/messages',         { credentials: 'include' }),
    ]);
    if (!reqRes.ok || !msgRes.ok) return;

    const requests = await reqRes.json();
    const convs    = await msgRes.json();

    const reqCount = Array.isArray(requests) ? requests.length : 0;
    const msgCount = Array.isArray(convs)
      ? convs.reduce((sum, c) => sum + (parseInt(c.unread_count) || 0), 0)
      : 0;

    const reqNew = _prevReqCount !== -1 && reqCount > _prevReqCount;
    const msgNew = _prevMsgCount !== -1 && msgCount > _prevMsgCount;

    _setBadge('friendsBadge',  reqCount, reqNew);
    _setBadge('messagesBadge', msgCount, msgNew);

    if (reqNew) _flashNavItem('[aria-label="Friends"]');
    if (msgNew) _flashNavItem('[aria-label="Messages"]');

    _prevReqCount = reqCount;
    _prevMsgCount = msgCount;
  } catch (e) {}
}

function _setBadge(id, count, animate) {
  const el = document.getElementById(id);
  if (!el) return;
  const label = count > 9 ? '9+' : String(count);
  if (count > 0) {
    el.textContent   = label;
    el.style.display = 'flex';
    if (animate) {
      el.classList.remove('cc-badge-pop');
      // Force reflow so the animation re-triggers
      void el.offsetWidth;
      el.classList.add('cc-badge-pop');
    }
  } else {
    el.style.display = 'none';
    el.textContent   = '';
  }
}

function _flashNavItem(selector) {
  const link = document.querySelector('.cc-tab-bar ' + selector);
  if (!link) return;
  link.classList.add('cc-nav-flash');
  setTimeout(() => link.classList.remove('cc-nav-flash'), 800);
}

// Start polling; safe to call multiple times — only one interval runs.
function startBadgePolling(intervalMs) {
  if (_badgeInterval) return;
  _badgeInterval = setInterval(refreshBadges, intervalMs || 5000);
}

// Auto-start polling as soon as the script is loaded.
// Pages that need it just include this file; no extra call needed.
document.addEventListener('DOMContentLoaded', () => startBadgePolling(5000));
