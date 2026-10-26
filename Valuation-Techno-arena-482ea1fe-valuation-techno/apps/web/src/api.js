const BASE = '/api';
export const token = () => localStorage.getItem('vt_token');
export const sessionUser = () => { try { return JSON.parse(localStorage.getItem('vt_user')); } catch { return null; } };
export function setSession(t, u) { localStorage.setItem('vt_token', t); localStorage.setItem('vt_user', JSON.stringify(u)); }
export function clearSession() { localStorage.removeItem('vt_token'); localStorage.removeItem('vt_user'); }
export async function api(path, opts = {}) {
  const t = token();
  // Send the token three ways: Bearer, X-Auth-Token, and the HttpOnly cookie set at login.
  // Some preview/proxy layers strip Authorization — the other transports keep the session alive.
  const res = await fetch(BASE + path, {
    credentials: 'same-origin',
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}`, 'X-Auth-Token': t } : {}), ...(opts.headers || {}) },
  });
  const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  if (res.status === 401 && t && !path.startsWith('/auth/')) {
    // Session truly expired (e.g. server data reset) — send the user back to login instead of dead buttons.
    clearSession();
    if (location.pathname !== '/') { sessionStorage.setItem('vt_notice', 'Session expired — please login again.'); location.href = '/'; }
    throw new Error('Session expired — please login again.');
  }
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}
export async function logoutApi() { try { await fetch(BASE + '/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch { /* best effort */ } clearSession(); }
// Open an authenticated file (report HTML / PDF) — fetch as blob so auth transports are applied.
export async function openAuthed(path) {
  const w = window.open('about:blank', '_blank'); const t = token();
  const res = await fetch(path.startsWith('/api') ? path : BASE + path, { credentials: 'same-origin', headers: { ...(t ? { Authorization: `Bearer ${t}`, 'X-Auth-Token': t } : {}) } });
  if (!res.ok) { const tx = await res.text(); if (w) w.close(); throw new Error(tx.slice(0, 200) || `Failed (${res.status})`); }
  const blob = await res.blob(); const url = URL.createObjectURL(blob);
  if (w) w.location = url; else { const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.click(); }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
export const inr = (n) => n === null || n === undefined ? '—' : '₹' + Number(n).toLocaleString('en-IN');
export const fmtDate = (s) => s ? new Date(s).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
