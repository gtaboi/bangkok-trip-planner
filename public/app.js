// Bangkok Trip Planner client. Loaded with <script defer>; no inline handlers (CSP: script-src 'self').
/* global module */ // only defined when the pure helpers are loaded from Node (tests)
(function () {
  'use strict';

  const TOP_N = 5; // size of the "Top 5" banner and filter
  const POLL_MS = 10000; // how often the poll refreshes
  const FLASH_MS = 2400; // highlight time for a newly proposed card

  // ---------- pure helpers (no DOM) ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const byVotes = (a, b) => b.votes - a.votes || a.id - b.id;

  // The first n itineraries by votes (0-vote ones never count). Tied itineraries share a rank
  // (1, 2, 2, 4), and `tiedOut` says how many more are tied with the last one shown.
  // Used by both the Top 5 banner and the Final plan list, so the two always agree.
  function rankTop(itineraries, n) {
    const voted = itineraries.filter((i) => i.votes > 0).sort(byVotes);
    const ranked = voted.map((it) => ({ it, rank: 1 + voted.filter((o) => o.votes > it.votes).length }));
    const top = ranked.slice(0, n);
    const last = top[top.length - 1];
    const tiedOut = last ? ranked.slice(n).filter((r) => r.it.votes === last.it.votes).length : 0;
    return { top, tiedOut };
  }

  function sortItineraries(list, sortBy) {
    const cmp = sortBy === 'az' ? (a, b) => a.title.localeCompare(b.title) || a.id - b.id
      : sortBy === 'fewest' ? (a, b) => a.votes - b.votes || a.id - b.id
      : byVotes;
    return [...list].sort(cmp);
  }

  if (typeof module === 'object' && module.exports) module.exports = { rankTop, sortItineraries, esc };
  if (typeof document === 'undefined') return;

  // ---------- app state ----------
  let me = null;
  let cfg = null; // { maxVotes, maxMembers, minPassword, inviteRequired } from /api/me
  let state = { itineraries: [], members: [] };
  // The user's filter choices. render() reads these and never overwrites them.
  const filters = { sort: 'votes', minVotes: '0', cat: '', lead: '' };
  const FILTER_SELECTS = { sortBy: 'sort', minVotes: 'minVotes', catFilter: 'cat', leadFilter: 'lead' };
  let order = null; // itinerary ids in on-screen order; only re-sorted on request (#1)
  let deferred = false; // a poll render was skipped because the user was busy in the list
  let offline = false; // show the "can't refresh" toast once per outage
  let editingId = null; // itinerary open in the plan dialog
  let ready = Promise.resolve(); // settles once init() has loaded /api/me
  const inFlight = new Set();
  const failedImages = new Set();

  const $ = (s) => document.querySelector(s);

  async function call(path, body) {
    const opts = body === undefined ? {} : {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    };
    const res = await fetch(path, opts);
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && me) { me = null; show(); }
    if (!res.ok) throw new Error(data.error || 'Something went wrong');
    return data;
  }
  const post = (path, body = {}) => call(path, body);

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  // ---------- login / session ----------
  async function init() {
    try {
      const d = await call('/api/me');
      cfg = { maxVotes: d.maxVotes, maxMembers: d.maxMembers, minPassword: d.minPassword, inviteRequired: !!d.inviteRequired };
      me = d.user;
      setupLoginForm();
    } catch (e) {
      me = null;
      $('#lErr').textContent = `Couldn't reach the trip server (${e.message}). Reload the page to try again.`;
    }
    show();
  }

  function setupLoginForm() {
    $('#joinInfo').innerHTML = `Up to <b>${esc(cfg.maxMembers)}</b> travellers. New here? Pick a name and password and press <b>Register</b>.`;
    $('#lPass').minLength = cfg.minPassword;
    $('#passHint').textContent = `New accounts need a password of at least ${cfg.minPassword} characters.`;
    $('#codeRow').classList.toggle('hidden', !cfg.inviteRequired);
  }

  function show() {
    $('#loginView').classList.toggle('hidden', !!me);
    $('#appView').classList.toggle('hidden', !me);
    $('#whoami').classList.toggle('hidden', !me);
    if (me) {
      $('#meName').textContent = '👋 ' + me.username;
      refresh({ resort: true });
    } else {
      if ($('#planDialog').open) $('#planDialog').close();
      order = null;
    }
  }

  async function auth(kind) {
    const err = $('#lErr');
    err.textContent = '';
    await ready; // a fast click can beat the /api/me response
    if (!cfg) { err.textContent = "Can't reach the trip server. Reload the page to try again."; return; }
    const username = $('#lUser').value.trim();
    const password = $('#lPass').value;
    const code = $('#lCode').value.trim();
    if (!username || !password) { err.textContent = 'Enter your name and password.'; return; }
    const body = { username, password };
    if (kind === 'register') {
      if (password.length < cfg.minPassword) { err.textContent = `Pick a password of at least ${cfg.minPassword} characters.`; $('#lPass').focus(); return; }
      if (cfg.inviteRequired && !code) { err.textContent = 'Enter the invite code to register.'; $('#lCode').focus(); return; }
      body.code = code;
    }
    try {
      const d = await post('/api/' + kind, body);
      me = d.user;
      $('#lPass').value = '';
      $('#lCode').value = '';
      show();
    } catch (e) { err.textContent = e.message; }
  }

  async function logout(all) {
    if (all && !confirm('Log out of all devices, including this one?')) return;
    try {
      await post(all ? '/api/logout-all' : '/api/logout');
      me = null;
      show();
      if (all) toast('Logged out on all devices.');
    } catch (e) { toast(e.message); }
  }

  // ---------- data ----------
  // Never rejects: errors become a toast.
  async function refresh({ resort = false, fromPoll = false } = {}) {
    try {
      const next = await call('/api/state');
      if (!me) return;
      state = next;
      offline = false;
      if (fromPoll && isBusy()) { deferred = true; return; }
      deferred = false;
      render({ resort });
    } catch (e) {
      if (me && !offline) { offline = true; toast(`Couldn't refresh: ${e.message}`); }
    }
  }

  async function act(id, action, body = {}) {
    const key = id + ':' + action;
    if (inFlight.has(key)) return false;
    inFlight.add(key);
    try {
      await post(`/api/itineraries/${id}/${action}`, body);
      await refresh();
      return true;
    } catch (e) {
      toast(e.message);
      refresh(); // the refusal usually means our copy is out of date (e.g. a 409 on delete)
      return false;
    } finally { inFlight.delete(key); }
  }

  const findIt = (id) => state.itineraries.find((i) => i.id === id);

  // ---------- rendering ----------
  const COLORS = ['#c2410c', '#0f766e', '#7c3aed', '#be185d', '#1d4ed8', '#b45309', '#15803d', '#9f1239', '#0369a1', '#4d7c0f'];
  function avatar(name) {
    const m = state.members.find((x) => x.username === name);
    const color = COLORS[((m ? m.id : name.length) - 1) % COLORS.length];
    return `<span class="av" style="background:${color}">${esc(name.slice(0, 1).toUpperCase())}</span>`;
  }
  function votersHTML(it) {
    const names = it.voters ? it.voters.split(', ') : [];
    if (!names.length) return '<div class="voters muted">No votes yet. Be the first!</div>';
    return `<div class="voters"><span class="muted">Voted by:</span>${names.map((n) =>
      `<span class="chip ${n === me.username ? 'me' : ''}">${avatar(n)}${esc(n)}${n === me.username ? ' (you)' : ''}</span>`).join('')}</div>`;
  }

  // Thumbnails: the server resolves photos to it.image_url (upload.wikimedia.org) and it.image_link
  // (the Wikipedia page). Without a photo we show a gradient tile with the category's emoji.
  const CAT_STYLE = {
    'Culture': ['🛕', '#b45309', '#f59e0b'], 'Food': ['🍜', '#c2410c', '#fb923c'], 'Shopping': ['🛍️', '#be185d', '#f472b6'],
    'Nightlife': ['🌃', '#312e81', '#7c3aed'], 'Day trip': ['🚐', '#0f766e', '#2dd4bf'], 'Outdoors': ['🌳', '#15803d', '#4ade80'],
    'Wellness': ['💆', '#0e7490', '#67e8f9'], 'Family / fun': ['🦒', '#a16207', '#facc15'],
  };
  const catStyle = (category) => CAT_STYLE[category] || ['✨', '#57534e', '#a8a29e'];
  const thumbStyle = (category) => { const [, c1, c2] = catStyle(category); return `background:linear-gradient(135deg,${c1},${c2})`; };
  function thumbInner(it) {
    const url = it.image_url && !failedImages.has(it.image_url) ? it.image_url : null;
    const img = url ? `<img src="${esc(url)}" alt="${esc(it.title)}" loading="lazy">` : '';
    const link = url && it.image_link
      ? `<a href="${esc(it.image_link)}" target="_blank" rel="noopener noreferrer" title="Photo source" aria-label="Photo source for ${esc(it.title)}"></a>` : '';
    return catStyle(it.category)[0] + img + link;
  }
  const thumbHTML = (it) => `<div class="thumb" style="${thumbStyle(it.category)}">${thumbInner(it)}</div>`;

  function itemHTML(it, ctx, rank) {
    const mineLead = it.lead_id === me.id;
    let lead;
    if (it.lead_id) {
      lead = `<span class="muted">Lead:</span> <span class="who">${esc(it.lead_name)}</span>` +
        (mineLead ? ` <button type="button" data-action="edit" data-id="${it.id}">Edit plan</button> <button type="button" data-action="release" data-id="${it.id}">Step down</button>` : '');
    } else {
      lead = `<span class="muted">No lead yet</span> <button type="button" data-action="claim" data-id="${it.id}" ${ctx.iLead ? 'disabled title="You already lead an itinerary"' : ''}>I'll be in charge</button>`;
    }
    const plan = (it.day || it.notes) ? `<div class="plan">${it.day ? '<b>📅 ' + esc(it.day) + '</b>\n' : ''}${esc(it.notes)}</div>` : '';
    const del = it.can_delete ? ` <button type="button" data-action="delete" data-id="${it.id}">Delete</button>` : '';
    const pct = ctx.best ? Math.round((it.votes / ctx.best) * 100) : 0;
    return `<div class="card item ${ctx.topIds.has(it.id) ? 'top' : ''}" data-card="${it.id}">
    <div class="votebox"><div class="n">${it.votes}</div><div class="muted" style="margin-bottom:4px">vote${it.votes === 1 ? '' : 's'}</div>
      <button type="button" class="${it.my_vote ? 'on' : ''}" data-action="vote" data-id="${it.id}" aria-pressed="${it.my_vote ? 'true' : 'false'}" aria-label="${it.my_vote ? 'Remove your vote for' : 'Vote for'} ${esc(it.title)}">${it.my_vote ? '✓ Voted' : 'Vote'}</button></div>
    ${thumbHTML(it)}
    <div class="body">
      <div class="title">${rank ? `<span class="rank">#${rank}</span>` : ''}${esc(it.title)}</div>
      <div class="meta">${it.category ? `<span class="tag cat">${esc(it.category)}</span>` : ''}${['area', 'duration', 'cost'].filter((k) => it[k]).map((k) => `<span class="tag">${esc(it[k])}</span>`).join('')}</div>
      <div>${esc(it.description)}</div>
      ${ctx.best ? `<div class="bar" title="${pct}% of the top itinerary's votes"><div style="width:${pct}%"></div></div>` : ''}
      ${votersHTML(it)}
      <div class="lead">${lead}${del}</div>
      ${plan}
    </div></div>`;
  }

  // Rebuild a select's options only when they change, so an open dropdown isn't closed (#8).
  function setOptions(sel, opts, value) {
    const key = JSON.stringify(opts);
    if (sel.dataset.key !== key) {
      sel.innerHTML = opts.map(([v, label]) => `<option value="${esc(v)}">${esc(label)}</option>`).join('');
      sel.dataset.key = key;
    }
    if (sel.value !== value) sel.value = value;
  }

  // Focus handling (#1): remember which button had focus and put it back after re-render.
  function focusKey() {
    const el = document.activeElement;
    const btn = el && el.closest && el.closest('[data-action][data-id]');
    const region = btn && btn.closest('#pollList, #topList');
    return region ? { region: region.id, action: btn.dataset.action, id: btn.dataset.id } : null;
  }
  function restoreFocus(k) {
    if (!k) return;
    const region = document.getElementById(k.region);
    // Same button if it still exists; else its replacement in the lead row (claim -> Edit plan); else the vote button.
    const target = region.querySelector(`[data-action="${k.action}"][data-id="${k.id}"]`) ||
      region.querySelector(`[data-card="${k.id}"] .lead button:not(:disabled)`) ||
      region.querySelector(`[data-card="${k.id}"] button:not(:disabled)`);
    if (target) target.focus({ preventScroll: true });
  }
  // The poll skips re-rendering while the user is working inside the list or a dropdown.
  function isBusy() {
    const el = document.activeElement;
    if ($('#planDialog').open) return true;
    if (!el || el === document.body) return false;
    return el.tagName === 'SELECT' || !!el.closest('#pollList, #topList, #bestBox');
  }

  function matchesFilters(it, topIds) {
    const mv = filters.minVotes;
    if (mv === 'top' ? !topIds.has(it.id) : it.votes < Number(mv)) return false;
    if (filters.cat && it.category !== filters.cat) return false;
    if (filters.lead === 'open' && it.lead_id) return false;
    if (filters.lead === 'taken' && !it.lead_id) return false;
    return true;
  }

  function render({ resort = false } = {}) {
    if (!me || !cfg) return;
    const k = focusKey();
    const all = state.itineraries;
    const used = all.filter((i) => i.my_vote).length;
    $('#voteInfo').innerHTML = `You have used <b>${used} of ${cfg.maxVotes}</b> votes. Click again to remove a vote. Each traveller can be in charge of <b>one</b> itinerary.`;

    const best = Math.max(0, ...all.map((i) => i.votes));
    const { top, tiedOut } = rankTop(all, TOP_N);
    const ctx = { best, topIds: new Set(top.map((r) => r.it.id)), iLead: all.some((x) => x.lead_id === me.id) };

    // Top 5 banner
    const MEDALS = ['🥇', '🥈', '🥉'];
    const lastVotes = top.length ? top[top.length - 1].it.votes : 0;
    $('#bestBox').innerHTML = top.length ? `<div class="card best">
      <span class="badge">🏆 Top ${top.length} itinerar${top.length === 1 ? 'y' : 'ies'} so far</span>
      ${top.map(({ it: w, rank }) => `<div class="best-row">
          <div class="rank-big">${MEDALS[rank - 1] || '#' + rank}</div>
          ${thumbHTML(w)}
          <div class="best-info"><div class="title">${esc(w.title)}</div>
            <div class="muted"><b>${w.votes}</b> vote${w.votes === 1 ? '' : 's'}<span class="lead-part">${w.lead_name ? ` · Lead: ${esc(w.lead_name)}` : ' · No lead yet'}</span></div>
            ${votersHTML(w)}</div></div>`).join('')}
      ${tiedOut ? `<p class="muted" style="margin:8px 0 0">+${tiedOut} more tied at ${plural(lastVotes, 'vote')}.</p>` : ''}
    </div>` : '';

    // Filter dropdowns: keep the user's choice even when nothing matches it right now (#8)
    const mv = filters.minVotes;
    const voteOpts = [['0', 'Any number of votes']];
    if (top.length || mv === 'top') voteOpts.push(['top', `Top ${TOP_N} only${top.length ? '' : ' (none right now)'}`]);
    for (let n = 1; n <= best; n++) voteOpts.push([String(n), `${n}+ votes`]);
    if (mv !== 'top' && Number(mv) > best) voteOpts.push([mv, `${mv}+ votes (none right now)`]);
    setOptions($('#minVotes'), voteOpts, mv);

    const cats = [...new Set(all.map((i) => i.category).filter(Boolean))];
    const catOpts = cats.map((c) => [c, c]);
    if (filters.cat && !cats.includes(filters.cat)) catOpts.push([filters.cat, `${filters.cat} (0 now)`]);
    catOpts.sort((a, b) => a[0].localeCompare(b[0]));
    setOptions($('#catFilter'), [['', 'All categories'], ...catOpts], filters.cat);
    $('#sortBy').value = filters.sort;
    $('#leadFilter').value = filters.lead;

    // Poll list in a stable order (#1): new itineraries go to the end until the user re-sorts
    const sorted = sortItineraries(all, filters.sort).map((i) => i.id);
    if (resort || !order) order = sorted;
    else {
      const ids = new Set(all.map((i) => i.id));
      const known = new Set(order);
      order = order.filter((id) => ids.has(id)).concat(sorted.filter((id) => !known.has(id)));
    }
    const pos = new Map(order.map((id, n) => [id, n]));
    const shown = all.filter((i) => matchesFilters(i, ctx.topIds)).sort((a, b) => pos.get(a.id) - pos.get(b.id));
    const shownIds = new Set(shown.map((i) => i.id));
    const stale = sorted.filter((id) => shownIds.has(id)).some((id, n) => id !== shown[n].id);
    $('#staleHint').classList.toggle('hidden', !stale);
    $('#resortBtn').textContent = filters.sort === 'az' ? 'Re-sort A–Z' : 'Re-sort by votes';

    const active = [];
    if (mv === 'top') active.push(`in the top ${TOP_N}`); else if (Number(mv)) active.push(`with ${mv}+ votes`);
    if (filters.cat) active.push(`in ${filters.cat}`);
    if (filters.lead) active.push(filters.lead === 'open' ? 'needing a lead' : 'with a lead');
    $('#filterInfo').textContent = `Showing ${shown.length} of ${all.length} itineraries${active.length ? ' ' + active.join(', ') : ''}.`;
    $('#pollList').innerHTML = shown.map((i) => itemHTML(i, ctx)).join('') ||
      '<p class="muted">Nothing matches your filters. <button type="button" data-action="clear-filters">Show all itineraries</button></p>';

    // Final plan: members + top N (one per traveller), ranked the same way as the banner (#3)
    $('#memberRows').innerHTML = state.members.map((m) =>
      `<tr><td>${esc(m.username)}${m.id === me.id ? ' (you)' : ''}</td><td>${m.leads ? esc(m.leads) : '<span class="muted">— not yet</span>'}</td><td>${m.votes_used}/${cfg.maxVotes}</td></tr>`).join('');
    const plan = rankTop(all, cfg.maxMembers);
    const planLast = plan.top.length ? plan.top[plan.top.length - 1].it.votes : 0;
    $('#topInfo').textContent = `The top ${cfg.maxMembers} itineraries, ideally one per traveller. Leads set the day and logistics.`;
    $('#topList').innerHTML = (plan.top.map(({ it, rank }) => itemHTML(it, ctx, rank)).join('') +
      (plan.tiedOut ? `<p class="muted">+${plan.tiedOut} more tied at ${plural(planLast, 'vote')}.</p>` : '')) ||
      '<p class="muted">No votes yet.</p>';

    restoreFocus(k);
  }

  // ---------- plan editor ----------
  function editPlan(id) {
    const it = findIt(id);
    if (!it) return;
    editingId = id;
    $('#planFor').textContent = it.title;
    $('#planDay').value = it.day || '';
    $('#planNotes').value = it.notes || '';
    $('#planErr').textContent = '';
    $('#planDialog').showModal();
    $('#planDay').focus();
  }
  $('#planForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (editingId === null) return;
    const id = editingId;
    try {
      await post(`/api/itineraries/${id}/details`, { day: $('#planDay').value, notes: $('#planNotes').value });
      editingId = null;
      $('#planDialog').close();
      await refresh();
      const btn = $(`#pollList [data-action="edit"][data-id="${id}"]`) || $(`#topList [data-action="edit"][data-id="${id}"]`);
      if (btn && btn.offsetParent) btn.focus({ preventScroll: true });
      toast('Plan saved.');
    } catch (err) { $('#planErr').textContent = err.message; }
  });
  $('#planDialog').addEventListener('close', () => { editingId = null; resumeDeferred(); });

  // ---------- delete ----------
  async function del(id) {
    const it = findIt(id);
    if (!it) return;
    let msg = `Delete "${it.title}"?`;
    if (it.other_votes > 0) msg += ` ${plural(it.other_votes, 'vote')} from other travellers will be removed.`;
    if (it.lead_id === me.id && (it.day || it.notes)) msg += ' Your plan notes will be removed too.';
    if (!confirm(msg)) return;
    if (await act(id, 'delete')) toast('Deleted.');
  }

  // ---------- tabs / filters ----------
  function showTab(name) {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x.dataset.tab === name));
    ['poll', 'plan', 'propose'].forEach((t) => $('#tab-' + t).classList.toggle('hidden', t !== name));
  }
  function clearFilters() {
    Object.assign(filters, { sort: 'votes', minVotes: '0', cat: '', lead: '' });
  }
  $('#filters').addEventListener('change', (e) => {
    const key = FILTER_SELECTS[e.target.id];
    if (!key) return;
    filters[key] = e.target.value;
    render({ resort: true });
  });

  // ---------- one click listener for every button (event delegation, #9) ----------
  const ACTIONS = {
    vote: (id) => act(id, 'vote'),
    claim: (id) => act(id, 'claim'),
    release: (id) => act(id, 'release'),
    edit: (id) => editPlan(id),
    delete: (id) => del(id),
    resort: () => render({ resort: true }),
    'clear-filters': () => { clearFilters(); render({ resort: true }); },
    tab: (_id, el) => { showTab(el.dataset.tab); if (me) refresh(); },
    register: () => auth('register'),
    logout: () => logout(false),
    'logout-all': () => logout(true),
    'plan-cancel': () => $('#planDialog').close(),
  };
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el || el.disabled) return;
    const fn = ACTIONS[el.dataset.action];
    if (!fn) return;
    e.preventDefault();
    fn(el.dataset.id === undefined ? null : Number(el.dataset.id), el);
  });

  // Broken photos: drop the <img> and its "Photo source" link so the placeholder shows (capture phase,
  // because error events don't bubble).
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement)) return;
    const thumb = img.closest('.thumb');
    if (!thumb) return;
    failedImages.add(img.getAttribute('src'));
    thumb.querySelectorAll('a').forEach((a) => a.remove());
    img.remove();
  }, true);

  $('#loginForm').addEventListener('submit', (e) => { e.preventDefault(); auth('login'); });

  // ---------- propose ----------
  const UPLOAD_RE = /^https:\/\/upload\.wikimedia\.org\/\S+$/;
  const WIKI_RE = /^https:\/\/[a-z-]+(\.m)?\.wikipedia\.org\/wiki\/\S+$/;
  function updatePreview() {
    const f = $('#proposeForm');
    const url = f.image.value.trim();
    const t = $('#previewThumb');
    // Only direct Wikimedia images are shown; Wikipedia pages are resolved by the server after you add the idea.
    t.setAttribute('style', thumbStyle(f.category.value));
    t.innerHTML = thumbInner({ category: f.category.value, title: 'Preview', image_url: UPLOAD_RE.test(url) ? url : null });
    $('#previewNote').textContent = WIKI_RE.test(url) ? 'Thumbnail preview (the Wikipedia photo appears once the idea is added)' : 'Thumbnail preview';
  }
  $('#proposeForm').addEventListener('input', updatePreview);
  updatePreview();

  $('#proposeForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    try {
      const created = await post('/api/itineraries', Object.fromEntries(new FormData(form)));
      form.reset();
      updatePreview();
      // Show the new card: clear filters, go to the poll, scroll to it and highlight it (#8)
      clearFilters();
      showTab('poll');
      await refresh({ resort: true });
      // The server returns the new id; fall back to my highest-id itinerary if it doesn't.
      let newId = Number(created && created.id) || null;
      if (!newId) {
        const mine = state.itineraries.filter((i) => i.created_by === me.id);
        newId = mine.length ? Math.max(...mine.map((i) => i.id)) : null;
      }
      const card = newId && $(`#pollList [data-card="${newId}"]`);
      if (card) {
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card.classList.add('flash');
        setTimeout(() => card.classList.remove('flash'), FLASH_MS);
      }
      toast('Added to the poll!');
    } catch (err) { toast(err.message); }
  });

  // ---------- polling ----------
  function resumeDeferred() {
    setTimeout(() => { if (deferred && me && !isBusy()) refresh(); }, 0);
  }
  document.addEventListener('focusout', resumeDeferred);
  setInterval(() => {
    if (!me || document.hidden) return;
    if (isBusy()) { deferred = true; return; }
    refresh({ fromPoll: true });
  }, POLL_MS);

  ready = init();
})();
