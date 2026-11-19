// Mock API Studio — admin UI. Vanilla JS, no build step.
// Everything is rendered with DOM APIs (no innerHTML with data) so record
// contents can never inject markup.

const $ = (sel, root = document) => root.querySelector(sel);
const PAGE = 50;

// ---------- DOM helpers ----------
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, kids);
  return el;
}
function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k === null || k === undefined || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}
function icon(id, cls) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  if (cls) svg.setAttribute('class', cls);
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${id}`);
  svg.append(use);
  return svg;
}
const clear = (el) => { el.replaceChildren(); return el; };

// ---------- App state ----------
const S = {
  info: null,
  resources: [],
  route: { view: 'resource', name: 'vms' },
  list: { name: null, skip: 0, q: '', sortBy: '', order: 'asc', total: 0, items: [], loading: false },
  insp: null, // { def, isNew, originalId, original, working, mode, jsonError, dirty }
  logTimer: null,
};

// ---------- API ----------
class ApiError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    throw new ApiError(res.status, data?.error_description || `${res.status} ${res.statusText}`);
  }
  return data;
}

// ---------- Toasts ----------
function toast(message, { error = false, action, timeout = 4500 } = {}) {
  const el = h('div', { class: `toast${error ? ' error' : ''}` }, h('span', {}, message));
  if (action) {
    el.append(h('button', { class: 'btn plain small', type: 'button', onclick: () => { el.remove(); action.run(); } }, action.label));
  }
  $('#toasts').append(el);
  setTimeout(() => el.remove(), action ? 8000 : timeout);
}
const fail = (e) => toast(e.message || String(e), { error: true, timeout: 7000 });

// ---------- Sheets (modal dialogs) ----------
function openSheet({ title, subtitle, body, submitLabel, danger = false, onSubmit, cancelLabel = 'Cancel', wide = false }) {
  const dlg = $('#sheet');
  const error = h('p', { class: 'error-text', role: 'alert', hidden: true });
  const submit = h('button', { class: `btn ${danger ? 'danger filled' : 'primary'}`, type: 'submit' }, submitLabel);
  const form = h('form', { method: 'dialog' },
    h('div', { class: 'sheet-head' }, h('h2', { id: 'sheet-title' }, title), subtitle ? h('p', { class: 'secondary' }, subtitle) : null),
    h('div', { class: 'sheet-body' }, body, error),
    h('div', { class: 'sheet-foot' },
      cancelLabel ? h('button', { class: 'btn', type: 'button', value: 'cancel', onclick: () => dlg.close('cancel') }, cancelLabel) : null,
      submit));
  dlg.classList.toggle('wide', wide);
  return new Promise((resolve) => {
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      error.hidden = true;
      submit.disabled = true;
      try {
        const result = await onSubmit?.(form);
        dlg.close('ok');
        resolve(result ?? true);
      } catch (e) {
        error.textContent = e.message;
        error.hidden = false;
      } finally {
        submit.disabled = false;
      }
    });
    dlg.addEventListener('close', () => { if (dlg.returnValue !== 'ok') resolve(false); }, { once: true });
    clear(dlg).append(form);
    dlg.setAttribute('aria-labelledby', 'sheet-title');
    dlg.returnValue = '';
    dlg.showModal();
    form.querySelector('input:not([type=hidden]), textarea, select')?.focus();
  });
}
const confirmSheet = (title, subtitle, label, danger = true) =>
  openSheet({ title, subtitle, body: null, submitLabel: label, danger });


async function boot() {
  S.info = await api('GET', '/__admin/info');
  $('#app').hidden = false;
  const badge = $('#storage-badge');
  badge.textContent = S.info.storage === 'mongodb' ? 'MongoDB' : 'In-memory';
  badge.className = `storage ${S.info.storage}`;
  badge.title = S.info.storage === 'mongodb' ? 'Data is saved in MongoDB' : 'Data resets when the server restarts. Set MONGODB_URI to keep it.';
  await loadResources();
  route();
}

// ---------- Sidebar ----------
async function loadResources() {
  const { resources } = await api('GET', '/__admin/resources');
  S.resources = resources.sort((a, b) => (b.builtin ? 1 : 0) - (a.builtin ? 1 : 0) || a.name.localeCompare(b.name));
  renderSidebar();
}
function renderSidebar() {
  const ul = clear($('#resource-list'));
  for (const r of S.resources) {
    ul.append(h('li', {},
      h('a', { href: `#/r/${encodeURIComponent(r.name)}`, dataset: { nav: `r:${r.name}` } },
        icon(r.builtin ? 'server' : 'table'), r.name,
        h('span', { class: 'count', 'aria-label': `${r.count} records` }, r.count))));
  }
  markNav();
}
function markNav() {
  const cur = S.route.view === 'resource' ? `r:${S.route.name}` : S.route.view;
  document.querySelectorAll('#sidebar [data-nav]').forEach((a) => {
    if (a.dataset.nav === cur) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}
$('#new-resource').addEventListener('click', newResourceSheet);

function toggleSidebar() {
  const app = $('#app');
  if (matchMedia('(max-width: 760px)').matches) app.classList.toggle('show-sidebar');
  else app.classList.toggle('no-sidebar');
}

// ---------- Router ----------
async function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [view, name, sub] = hash.split('/');
  let next;
  if (view === 'r' && name && sub === 'access') next = { view: 'credentials', filter: decodeURIComponent(name) };
  else if (view === 'credentials') next = { view: 'credentials', filter: name ? decodeURIComponent(name) : '' };
  else if (view === 'r' && name) next = { view: 'resource', name: decodeURIComponent(name) };
  else if (['connection', 'controls', 'log'].includes(view)) next = { view };
  else next = { view: 'resource', name: 'vms' };

  if (S.insp?.dirty && !(await confirmDiscard())) {
    history.replaceState(null, '', S.route.view === 'resource' ? `#/r/${S.route.name}` : `#/${S.route.view}`);
    return;
  }
  clearInterval(S.logTimer);
  $('#app').classList.remove('show-sidebar');
  if (next.view !== 'resource' || next.name !== S.route.name) closeInspector(true);
  S.route = next;
  markNav();
  if (next.view === 'resource') return showResource(next.name);
  if (next.view === 'credentials') return showCredentials(next.filter);
  if (next.view === 'connection') return showConnection();
  if (next.view === 'controls') return showControls();
  if (next.view === 'log') return showLog();
}
window.addEventListener('hashchange', route);

const currentDef = () => S.resources.find((r) => r.name === S.route.name);

// ---------- Toolbar shared bits ----------
const sidebarButton = () =>
  h('button', { class: 'btn icon plain', type: 'button', 'aria-label': 'Show or hide sidebar', title: 'Show or hide sidebar', onclick: toggleSidebar }, icon('sidebar'));

function copyButton(text, label = 'Copy') {
  return h('button', {
    class: 'btn icon plain', type: 'button', 'aria-label': `${label}`, title: label,
    onclick: async (ev) => {
      try {
        await navigator.clipboard.writeText(text);
        const b = ev.currentTarget;
        b.replaceChildren(icon('check'));
        setTimeout(() => b.replaceChildren(icon('copy')), 1200);
      } catch { toast('Copy isn’t available in this browser.', { error: true }); }
    },
  }, icon('copy'));
}

// ---------- Resource view ----------
async function showResource(name) {
  if (!S.resources.some((r) => r.name === name)) await loadResources();
  const def = currentDef();
  const main = clear($('#main'));
  if (!def) {
    main.append(h('div', { class: 'empty' }, icon('table'), h('h2', {}, `No resource named “${name}”`),
      h('a', { href: '#/r/vms' }, 'Go to vms')));
    return;
  }
  if (S.list.name !== name) Object.assign(S.list, { name, skip: 0, q: '', sortBy: '', order: 'asc' });

  const search = h('input', {
    type: 'search', placeholder: 'Search', 'aria-label': `Search ${name}`, value: S.list.q, id: 'search',
    oninput: debounce((ev) => { S.list.q = ev.target.value.trim(); S.list.skip = 0; loadList(); }, 250),
  });
  const endpoint = `/api/v1/${name}`;
  main.append(
    h('header', { class: 'toolbar' },
      sidebarButton(),
      h('div', { class: 'title' },
        h('h1', {}, name,
          h('span', { class: 'access', title: def.auth_required ? 'API callers need an API key or OAuth token' : 'Anyone can read and write this resource' },
            icon(def.auth_required ? 'lock' : 'globe'), def.auth_required ? 'Private' : 'Public')),
        h('span', { class: 'endpoint' }, h('span', { class: 'verb' }, 'GET'), h('code', {}, endpoint), copyButton(location.origin + endpoint, 'Copy endpoint URL'))),
      h('label', { class: 'search' }, icon('search'), search),
      h('button', { class: 'btn', type: 'button', onclick: () => importSheet(def) }, 'Import'),
      def.auth_required ? h('a', { class: 'btn', href: `#/credentials/${encodeURIComponent(name)}` }, icon('key'), 'Credentials') : null,
      h('button', { class: 'btn icon', type: 'button', 'aria-label': 'Resource settings', title: 'Resource settings', onclick: () => resourceSettingsSheet(def) }, icon('more')),
      h('button', { class: 'btn primary', type: 'button', title: 'New record (N)', onclick: () => newRecord() }, icon('plus'), 'New Record')),
    h('div', { class: 'table-wrap', id: 'table-wrap' }),
    h('footer', { class: 'footer', id: 'list-footer' }));
  await loadList();
}

async function loadList() {
  const def = currentDef();
  if (!def) return;
  const L = S.list;
  const qs = new URLSearchParams({ limit: PAGE, skip: L.skip, include_meta: 'true' });
  if (L.q) qs.set('q', L.q);
  if (L.sortBy) { qs.set('sortBy', L.sortBy); qs.set('order', L.order); }
  try {
    const data = await api('GET', `/__admin/data/${def.name}?${qs}`);
    L.items = data[def.name];
    L.total = data.total;
    def.count = L.q ? def.count : data.total;
    renderTable(def);
  } catch (e) { fail(e); }
}

const VM_COLUMNS = [
  { key: 'vm_id', label: 'VM ID', mono: true },
  { key: 'hostname', label: 'Hostname', render: (v) => hostnameCell(v.hostname) },
  { key: 'ip_address', label: 'IP Address', mono: true },
  { key: 'guest_os.family', label: 'Operating System', render: (v) => osText(v.guest_os) },
  { key: 'environment', label: 'Environment' },
  { key: 'status', label: 'Status' },
  { key: null, label: 'ServiceNow Result', render: (v) => outcomeChip(vmOutcome(v)) },
  { key: '_updated_at', label: 'Updated', render: (v) => h('span', { class: 'tertiary', title: v._updated_at }, relTime(v._updated_at)) },
];

function genericColumns(def, items) {
  const keys = [];
  for (const it of items.slice(0, 50)) {
    for (const k of Object.keys(it)) if (k !== def.id_field && !k.startsWith('_') && !keys.includes(k)) keys.push(k);
  }
  return [
    { key: def.id_field, label: def.id_field, mono: true },
    ...keys.slice(0, 6).map((k) => ({ key: k, label: k })),
    { key: '_updated_at', label: 'Updated', render: (v) => h('span', { class: 'tertiary', title: v._updated_at }, relTime(v._updated_at)) },
  ];
}

function renderTable(def) {
  const wrap = clear($('#table-wrap'));
  const L = S.list;
  const cols = def.name === 'vms' ? VM_COLUMNS : genericColumns(def, L.items);

  if (!L.items.length) {
    wrap.append(h('div', { class: 'empty' }, icon(L.q ? 'search' : 'table'),
      h('h2', {}, L.q ? `No results for “${L.q}”` : `No ${def.name} yet`),
      h('p', { class: 'secondary' }, L.q ? 'Try a different search.' : 'Add a record, or import a JSON array.'),
      L.q ? null : h('button', { class: 'btn primary', type: 'button', onclick: () => newRecord() }, icon('plus'), 'New Record')));
  } else {
    const thead = h('tr', {}, cols.map((c) => {
      if (!c.key) return h('th', { class: 'static', scope: 'col' }, c.label);
      const sorted = L.sortBy === c.key || (!L.sortBy && c.key === def.id_field);
      return h('th', { scope: 'col', 'aria-sort': sorted ? (L.order === 'desc' ? 'descending' : 'ascending') : null },
        h('button', { type: 'button', onclick: () => sortBy(c.key, def) }, c.label));
    }));
    const tbody = h('tbody');
    for (const item of L.items) {
      const id = item[def.id_field];
      const tr = h('tr', {
        tabindex: '0',
        'aria-selected': S.insp && !S.insp.isNew && S.insp.originalId === id ? 'true' : 'false',
        dataset: { id },
        onclick: () => openRecord(def, item),
        onkeydown: (ev) => rowKeys(ev, def, item),
      }, cols.map((c) => {
        const content = c.render ? c.render(item) : cellText(getPath(item, c.key));
        return h('td', { class: c.mono ? 'mono' : null }, content);
      }));
      tbody.append(tr);
    }
    wrap.append(h('table', { class: 'grid', 'aria-label': `${def.name} records` }, h('thead', {}, thead), tbody));
  }

  const footer = clear($('#list-footer'));
  const from = L.total ? L.skip + 1 : 0;
  const to = L.skip + L.items.length;
  footer.append(
    h('span', {}, L.total ? `${from}–${to} of ${L.total}` : '0 records', L.q ? ` matching “${L.q}”` : ''),
    h('div', { class: 'pager' },
      h('button', { class: 'btn icon', type: 'button', 'aria-label': 'Previous page', disabled: L.skip === 0, onclick: () => { L.skip = Math.max(0, L.skip - PAGE); loadList(); } }, icon('chev-l')),
      h('button', { class: 'btn icon', type: 'button', 'aria-label': 'Next page', disabled: to >= L.total, onclick: () => { L.skip += PAGE; loadList(); } }, icon('chev-r'))));
  renderSidebar();
}

function sortBy(key, def) {
  const L = S.list;
  const current = L.sortBy || def.id_field;
  if (current === key) L.order = L.order === 'asc' ? 'desc' : 'asc';
  else { L.sortBy = key; L.order = key === '_updated_at' ? 'desc' : 'asc'; }
  L.skip = 0;
  loadList();
}

function rowKeys(ev, def, item) {
  if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openRecord(def, item); }
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    ev.preventDefault();
    const sib = ev.key === 'ArrowDown' ? ev.currentTarget.nextElementSibling : ev.currentTarget.previousElementSibling;
    sib?.focus();
  }
}

function cellText(v) {
  if (v === undefined || v === null || v === '') return h('span', { class: 'empty-cell' }, '—');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
function hostnameCell(v) {
  if (v === undefined || v === null) return h('span', { class: 'empty-cell' }, 'missing');
  if (String(v).trim() === '') return h('span', { class: 'ws', title: 'Empty or whitespace only' }, v === '' ? 'empty' : '␣'.repeat(v.length));
  const m = String(v).match(/^(\s*)(.*?)(\s*)$/);
  return [m[1] ? h('span', { class: 'ws', title: 'Leading whitespace' }, '␣'.repeat(m[1].length)) : null, m[2],
    m[3] ? h('span', { class: 'ws', title: 'Trailing whitespace' }, '␣'.repeat(m[3].length)) : null];
}
function osText(os) {
  if (!os) return h('span', { class: 'empty-cell' }, '—');
  const parts = [os.name || os.family, os.version].filter(Boolean);
  return parts.length ? parts.join(' ') : h('span', { class: 'empty-cell' }, '—');
}

// ---------- ServiceNow outcome (mirrors the integration's mapping rules) ----------
const IPV4 = /^((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const STATUS_MAP = { running: 1, stopped: 2 };

function vmOutcome(vm) {
  const notes = [];
  const rawHost = vm.hostname;
  const host = (rawHost ?? '').toString().trim().toLowerCase();
  const ip = (vm.ip_address ?? '').toString().trim();
  const rejects = [];
  if (!host) rejects.push(rawHost === undefined || rawHost === null ? 'Hostname is missing' : 'Hostname is empty');
  if (!IPV4.test(ip)) rejects.push(ip ? `“${ip}” isn’t a valid IPv4 address` : 'IP address is missing');
  if (rejects.length) {
    return {
      kind: 'bad', label: 'Rejected', title: 'Rejected and written to u_etl_error_log',
      notes: [...rejects.map((t) => ({ level: 'bad', text: t })), { level: 'info', text: 'No CI is created for this record' }],
    };
  }
  const family = (vm.guest_os?.family ?? '').toString().trim().toLowerCase();
  const cls = family === 'windows' ? 'cmdb_ci_win_server' : family === 'linux' ? 'cmdb_ci_linux_server' : null;
  notes.push({ level: 'ok', text: ['cmdb_ci_vm_instance, object_id ', code(vm.vm_id)] });
  if (cls) notes.push({ level: 'ok', text: [code(cls), ' with a Virtualized by relationship'] });
  else notes.push({ level: 'warn', text: family ? `OS family “${vm.guest_os.family}” isn’t Windows or Linux. Only the VM is created, and it’s logged.` : 'No OS family. Only the VM is created, and it’s logged.' });
  if (rawHost !== host) notes.push({ level: 'info', text: ['name becomes ', code(host)] });
  if (vm.status !== undefined && !(String(vm.status) in STATUS_MAP)) notes.push({ level: 'warn', text: `Status “${vm.status}” has no operational_status mapping` });
  else if (vm.status !== undefined) notes.push({ level: 'info', text: ['operational_status ', code(STATUS_MAP[vm.status])] });
  if (typeof vm.ram_gb === 'number') notes.push({ level: 'info', text: ['ram ', code(`${vm.ram_gb * 1024} MB`)] });
  const sw = Array.isArray(vm.installed_software) ? vm.installed_software : [];
  if (sw.length && cls) {
    const keys = sw.map((s) => `${s?.name}|${s?.version}`);
    const dup = new Set(keys).size < keys.length;
    notes.push({ level: dup ? 'warn' : 'info', text: `${sw.length} software install${sw.length > 1 ? 's' : ''} upserted into cmdb_sam_sw_install${dup ? '. Includes duplicates, so the upsert has to dedupe them.' : ''}` });
  } else if (sw.length) notes.push({ level: 'warn', text: `${sw.length} software install${sw.length > 1 ? 's are' : ' is'} skipped because there’s no server CI to link to` });
  if (vm.last_seen !== undefined && Number.isNaN(Date.parse(vm.last_seen))) notes.push({ level: 'warn', text: `last_seen “${vm.last_seen}” isn’t valid ISO 8601` });
  if (!vm.owner_email) notes.push({ level: 'info', text: 'No owner email, so owned_by stays empty' });
  return cls
    ? { kind: 'ok', label: family === 'windows' ? 'Windows server' : 'Linux server', title: `Loads as VM + ${family === 'windows' ? 'Windows' : 'Linux'} server`, notes }
    : { kind: 'vm', label: 'VM only', title: 'Loads as VM instance only', notes };
}
const code = (t) => h('code', { class: 'val' }, String(t ?? ''));

function outcomeChip(o) {
  return h('span', { class: `outcome ${o.kind}` }, icon(o.kind === 'ok' ? 'check' : o.kind === 'bad' ? 'x' : 'warn'), o.label);
}
function outcomePreview(o) {
  const ICON = { ok: 'check', bad: 'x', warn: 'warn', info: 'arrow' };
  return h('section', { class: 'preview', 'aria-label': 'ServiceNow result' },
    h('div', { class: `preview-head ${o.kind}` }, icon(o.kind === 'ok' ? 'check' : o.kind === 'bad' ? 'x' : 'warn'), o.title),
    h('ul', {}, o.notes.map((n) => h('li', { class: n.level }, icon(ICON[n.level]), h('span', {}, n.text)))));
}

// ---------- Inspector ----------
async function confirmDiscard() {
  return confirmSheet('Discard Unsaved Changes?', 'Your edits to this record will be lost.', 'Discard');
}

async function openRecord(def, item) {
  if (S.insp?.dirty && !(await confirmDiscard())) return;
  const record = structuredClone(item);
  delete record._updated_at; delete record._created_at;
  S.insp = { def, isNew: false, originalId: record[def.id_field], original: record, working: structuredClone(record), mode: S.insp?.mode || 'form', dirty: false, meta: item };
  renderInspector();
  markSelectedRow();
}

async function newRecord(seed) {
  const def = currentDef();
  if (!def) return;
  if (S.insp?.dirty && !(await confirmDiscard())) return;
  let working = seed;
  if (!working) {
    working = def.name === 'vms'
      ? {
        hostname: 'new-vm-01', ip_address: '10.0.0.10', cloud_provider: 'aws', region: 'us-east-1',
        cpu_count: 2, ram_gb: 4, disk_gb: 64, environment: 'Development', status: 'running',
        last_seen: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        guest_os: { family: 'Linux', name: 'Ubuntu', version: '22.04' }, installed_software: [],
      }
      : {};
  }
  S.insp = { def, isNew: true, originalId: null, original: null, working, mode: def.name === 'vms' ? 'form' : 'json', dirty: true };
  renderInspector();
  markSelectedRow();
}

function closeInspector(force = false) {
  if (!force && S.insp?.dirty) {
    confirmDiscard().then((ok) => { if (ok) { S.insp.dirty = false; closeInspector(true); } });
    return;
  }
  S.insp = null;
  $('#inspector').hidden = true;
  markSelectedRow();
}
function markSelectedRow() {
  document.querySelectorAll('#table-wrap tbody tr').forEach((tr) => {
    tr.setAttribute('aria-selected', S.insp && !S.insp.isNew && tr.dataset.id === S.insp.originalId ? 'true' : 'false');
  });
}

function renderInspector() {
  const I = S.insp;
  const el = $('#inspector');
  el.hidden = false;
  const isVm = I.def.name === 'vms';
  const title = I.isNew ? `New ${isVm ? 'VM' : 'Record'}` : String(I.originalId);

  const modes = isVm
    ? h('div', { class: 'segmented', role: 'group', 'aria-label': 'Editor' },
      ['form', 'json'].map((m) => h('button', {
        type: 'button', 'aria-pressed': I.mode === m ? 'true' : 'false',
        onclick: () => { if (I.mode !== m && !I.jsonError) { I.mode = m; renderInspector(); } },
      }, m === 'form' ? 'Form' : 'JSON')))
    : null;

  const body = h('div', { class: 'insp-body', id: 'insp-body' });
  const saveBtn = h('button', { class: 'btn primary', type: 'button', id: 'save-btn', onclick: saveRecord }, I.isNew ? 'Create' : 'Save');
  const dirty = h('span', { class: 'dirty-dot', id: 'dirty-note' });

  clear(el).append(
    h('div', { class: 'insp-head' },
      h('h2', { title }, title), modes,
      h('button', { class: 'btn icon plain', type: 'button', 'aria-label': 'Close editor', title: 'Close (Esc)', onclick: () => closeInspector() }, icon('close'))),
    body,
    h('div', { class: 'insp-foot' },
      I.isNew ? null : h('button', { class: 'btn danger', type: 'button', onclick: deleteRecord }, 'Delete'),
      I.isNew ? null : h('button', { class: 'btn', type: 'button', onclick: duplicateRecord }, 'Duplicate'),
      h('span', { class: 'spacer' }), dirty, saveBtn));

  if (isVm) body.append(h('div', { id: 'preview-slot' }));
  if (isVm && I.mode === 'form') body.append(vmForm());
  else body.append(jsonEditor());
  if (!I.isNew && I.meta?._updated_at) {
    body.append(h('p', { class: 'tertiary' }, `Updated ${new Date(I.meta._updated_at).toLocaleString()}. Created ${new Date(I.meta._created_at).toLocaleString()}.`));
  }
  refreshInspectorState();
}

function refreshInspectorState() {
  const I = S.insp;
  if (!I) return;
  I.dirty = I.isNew || JSON.stringify(I.working) !== JSON.stringify(I.original);
  const slot = $('#preview-slot');
  if (slot) clear(slot).append(outcomePreview(vmOutcome(I.working)));
  $('#save-btn').disabled = !I.dirty || !!I.jsonError;
  $('#dirty-note').textContent = I.jsonError ? 'Fix the JSON to save' : I.dirty && !I.isNew ? 'Edited' : '';
}

// Path helpers ("guest_os.family", "installed_software.0.name")
function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (o[k] == null || typeof o[k] !== 'object') o[k] = /^\d+$/.test(keys[i + 1]) ? [] : {};
    o = o[k];
  }
  const last = keys.at(-1);
  if (value === undefined) {
    if (Array.isArray(o)) o[last] = undefined; else delete o[last];
  } else o[last] = value;
  // Drop now-empty parent objects so "missing" really is missing in the payload.
  if (keys[0] === 'guest_os' && obj.guest_os && !Object.keys(obj.guest_os).length) delete obj.guest_os;
}

function input(path, { label, type = 'text', mono = false, hint, list, placeholder, step } = {}) {
  const I = S.insp;
  const v = getPath(I.working, path);
  const id = `f-${path.replace(/\./g, '-')}`;
  const el = h('input', {
    id, type, class: mono ? 'mono' : null, value: v === undefined || v === null ? '' : String(v),
    list, placeholder, step, spellcheck: 'false', autocomplete: 'off',
    oninput: (ev) => {
      const raw = ev.target.value;
      let val = raw === '' ? undefined : raw;
      if (type === 'number' && val !== undefined) {
        const n = Number(raw);
        val = Number.isFinite(n) ? n : raw;
      }
      setPath(I.working, path, val);
      refreshInspectorState();
    },
  });
  return h('label', { class: 'field', for: id }, h('span', {}, label), el, hint ? h('span', { class: 'hint' }, hint) : null);
}

function datalist(id, options) {
  return h('datalist', { id }, options.map((o) => h('option', { value: o })));
}

function vmForm() {
  const I = S.insp;
  const wrap = h('div', { class: 'insp-form', id: 'vm-form' },
    datalist('dl-family', ['Linux', 'Windows']),
    datalist('dl-status', ['running', 'stopped', 'terminated', 'suspended']),
    datalist('dl-env', ['Production', 'Development', 'QA', 'Test', 'UAT', 'Staging']),
    datalist('dl-provider', ['aws', 'azure', 'gcp', 'vmware']),
    datalist('dl-cpu', ['Intel Corporation', 'AMD', 'GenuineIntel', 'AuthenticAMD']),
  );
  wrap.append(
    h('div', { class: 'fieldset' }, h('h3', {}, 'Identity'),
      input('vm_id', { label: 'VM ID', mono: true, hint: I.isNew ? 'Leave blank to generate one.' : 'Maps to object_id, the IRE identifier.' }),
      input('hostname', { label: 'Hostname', mono: true, hint: 'Leading or trailing spaces are kept, so you can test trimming.' }),
      input('ip_address', { label: 'IP Address', mono: true })),
    h('div', { class: 'fieldset' }, h('h3', {}, 'Guest OS'),
      h('div', { class: 'row2' },
        input('guest_os.family', { label: 'Family', list: 'dl-family' }),
        input('guest_os.name', { label: 'Name' })),
      h('div', { class: 'row2' },
        input('guest_os.version', { label: 'Version' }),
        input('guest_os.kernel', { label: 'Kernel', mono: true }))),
    h('div', { class: 'fieldset' }, h('h3', {}, 'Hardware'),
      h('div', { class: 'row3' },
        input('cpu_count', { label: 'CPUs', type: 'number', step: '1' }),
        input('ram_gb', { label: 'RAM (GB)', type: 'number', step: 'any' }),
        input('disk_gb', { label: 'Disk (GB)', type: 'number', step: 'any' })),
      input('cpu_manufacturer', { label: 'CPU Manufacturer', list: 'dl-cpu' }),
      h('div', { class: 'row2' },
        input('manufacturer', { label: 'Manufacturer' }),
        input('model', { label: 'Model' })),
      h('div', { class: 'row2' },
        input('cloud_provider', { label: 'Cloud Provider', list: 'dl-provider' }),
        input('region', { label: 'Region' }))),
    h('div', { class: 'fieldset' }, h('h3', {}, 'Ownership and State'),
      h('div', { class: 'row2' },
        input('environment', { label: 'Environment', list: 'dl-env' }),
        input('status', { label: 'Status', list: 'dl-status' })),
      input('owner_email', { label: 'Owner Email', type: 'email' }),
      h('div', { class: 'row2' },
        input('cost_center', { label: 'Cost Center', mono: true }),
        h('div', { class: 'field' },
          input('last_seen', { label: 'Last Seen', mono: true }),
          h('button', {
            class: 'btn small plain', type: 'button',
            onclick: () => {
              I.working.last_seen = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
              $('#f-last_seen').value = I.working.last_seen;
              refreshInspectorState();
            },
          }, 'Set to Now')))),
    softwareSection());
  return wrap;
}

function softwareSection() {
  const I = S.insp;
  const list = Array.isArray(I.working.installed_software) ? I.working.installed_software : [];
  const section = h('div', { class: 'fieldset', id: 'sw-section' },
    h('h3', {}, `Installed Software (${list.length})`));
  const items = h('div', { class: 'sw-list' });
  list.forEach((_, i) => {
    items.append(h('div', { class: 'sw-item' },
      input(`installed_software.${i}.name`, { label: 'Name' }),
      input(`installed_software.${i}.publisher`, { label: 'Publisher' }),
      h('button', {
        class: 'btn icon plain danger', type: 'button', 'aria-label': `Remove software ${i + 1}`, title: 'Remove',
        onclick: () => { list.splice(i, 1); rerenderSoftware(); },
      }, icon('close')),
      input(`installed_software.${i}.version`, { label: 'Version', mono: true }),
      input(`installed_software.${i}.install_date`, { label: 'Install Date', mono: true, placeholder: 'YYYY-MM-DD' })));
  });
  section.append(items, h('div', {},
    h('button', {
      class: 'btn small', type: 'button',
      onclick: () => {
        if (!Array.isArray(I.working.installed_software)) I.working.installed_software = [];
        I.working.installed_software.push({ name: '', publisher: '', version: '', install_date: new Date().toISOString().slice(0, 10) });
        rerenderSoftware();
        $(`#f-installed_software-${I.working.installed_software.length - 1}-name`)?.focus();
      },
    }, icon('plus'), 'Add Software')));
  return section;
}
function rerenderSoftware() {
  $('#sw-section').replaceWith(softwareSection());
  refreshInspectorState();
}

function jsonEditor() {
  const I = S.insp;
  const err = h('p', { class: 'error-text', role: 'alert', id: 'json-error', hidden: true });
  const ta = h('textarea', {
    class: 'json-editor', spellcheck: 'false', 'aria-label': 'Record JSON', 'aria-describedby': 'json-error',
    value: JSON.stringify(I.working, null, 2),
    oninput: (ev) => {
      try {
        const v = JSON.parse(ev.target.value);
        if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('The record must be a JSON object.');
        I.working = v;
        I.jsonError = null;
        ta.removeAttribute('aria-invalid');
        err.hidden = true;
      } catch (e) {
        I.jsonError = e.message;
        ta.setAttribute('aria-invalid', 'true');
        err.textContent = e.message;
        err.hidden = false;
      }
      refreshInspectorState();
    },
    onkeydown: (ev) => {
      if (ev.key === 'Tab' && !ev.shiftKey && !ev.metaKey) {
        ev.preventDefault();
        ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end');
        ta.dispatchEvent(new Event('input'));
      }
    },
  });
  const hint = I.isNew ? h('p', { class: 'tertiary' }, `Leave out “${I.def.id_field}” to generate one.`) : null;
  return h('div', { class: 'field' }, ta, err, hint);
}

function cleanForSave(doc) {
  const out = structuredClone(doc);
  if (Array.isArray(out.installed_software)) {
    out.installed_software = out.installed_software
      .filter(Boolean)
      .map((s) => Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined && v !== '')))
      .filter((s) => Object.keys(s).length);
  }
  return out;
}

async function saveRecord() {
  const I = S.insp;
  if (!I || !I.dirty || I.jsonError) return;
  const { def } = I;
  const body = cleanForSave(I.working);
  try {
    const saved = I.isNew
      ? await api('POST', `/__admin/data/${def.name}`, body)
      : await api('PUT', `/__admin/data/${def.name}/${encodeURIComponent(I.originalId)}`, body);
    const id = saved[def.id_field];
    toast(I.isNew ? `Created ${id}` : `Saved ${id}`);
    const now = new Date().toISOString();
    S.insp = { ...I, isNew: false, originalId: id, original: saved, working: structuredClone(saved), dirty: false, meta: { _updated_at: now, _created_at: I.meta?._created_at || now } };
    await loadList();
    await loadResources();
    renderInspector();
    markSelectedRow();
  } catch (e) { fail(e); }
}

async function deleteRecord() {
  const I = S.insp;
  const { def } = I;
  const id = I.originalId;
  const ok = await confirmSheet(`Delete ${id}?`, 'API callers will stop seeing this record. You can undo right after.', 'Delete');
  if (!ok) return;
  try {
    await api('DELETE', `/__admin/data/${def.name}/${encodeURIComponent(id)}`);
    const backup = I.original;
    S.insp.dirty = false;
    closeInspector(true);
    await loadList();
    await loadResources();
    toast(`Deleted ${id}`, {
      action: {
        label: 'Undo',
        run: async () => {
          try {
            await api('POST', `/__admin/data/${def.name}`, backup);
            toast(`Restored ${id}`);
            await loadList();
            await loadResources();
          } catch (e) { fail(e); }
        },
      },
    });
  } catch (e) { fail(e); }
}

function duplicateRecord() {
  const I = S.insp;
  const copy = structuredClone(I.working);
  delete copy[I.def.id_field];
  if (I.def.name === 'vms' && copy.hostname) copy.hostname = `${String(copy.hostname).trim()}-copy`;
  I.dirty = false;
  newRecord(copy);
}

// ---------- Resource sheets ----------
function newResourceSheet() {
  const name = h('input', { type: 'text', name: 'name', required: true, pattern: '[a-z][a-z0-9_\\-]{0,39}', placeholder: 'users', spellcheck: 'false', autocomplete: 'off' });
  const idField = h('input', { type: 'text', name: 'id_field', value: 'id', required: true, spellcheck: 'false', class: 'mono' });
  const desc = h('input', { type: 'text', name: 'description', placeholder: 'Optional' });
  const auth = h('input', { type: 'checkbox', name: 'auth_required', checked: false, role: 'switch' });
  const seed = h('textarea', { name: 'records', rows: 6, placeholder: '[\n  { "name": "Alice", "email": "alice@acme.com" }\n]' });
  return openSheet({
    title: 'New Resource',
    subtitle: 'Get GET, POST, PUT, PATCH and DELETE endpoints at /api/v1/<name>.',
    submitLabel: 'Create Resource',
    body: [
      h('label', { class: 'field' }, h('span', {}, 'Name'), name, h('span', { class: 'hint' }, 'Lowercase letters, numbers, - or _. This becomes the URL path.')),
      h('label', { class: 'field' }, h('span', {}, 'ID Field'), idField, h('span', { class: 'hint' }, 'Records missing this field get 1, 2, 3, and so on.')),
      h('label', { class: 'field' }, h('span', {}, 'Description'), desc),
      h('label', { class: 'switch' }, auth, h('span', {}, 'Private: callers need an API key, Basic login or OAuth token')),
      h('label', { class: 'field' }, h('span', {}, 'Starting Records (JSON array, optional)'), seed),
    ],
    onSubmit: async () => {
      let records;
      if (seed.value.trim()) {
        try { records = JSON.parse(seed.value); } catch (e) { throw new Error(`Starting records: ${e.message}`); }
        if (!Array.isArray(records)) throw new Error('Starting records must be a JSON array.');
      }
      const def = await api('POST', '/__admin/resources', {
        name: name.value.trim(), id_field: idField.value.trim(), description: desc.value, auth_required: auth.checked, records,
      });
      await loadResources();
      location.hash = `#/r/${def.name}`;
      toast(`Created /api/v1/${def.name}`);
    },
  });
}

function importSheet(def) {
  const ta = h('textarea', { rows: 12, required: true, placeholder: '[ { … }, { … } ]', spellcheck: 'false', 'aria-label': 'JSON array of records' });
  const file = h('input', {
    type: 'file', accept: 'application/json,.json', 'aria-label': 'Choose a JSON file',
    onchange: async (ev) => { const f = ev.target.files[0]; if (f) ta.value = await f.text(); },
  });
  const append = h('input', { type: 'radio', name: 'mode', value: 'append', checked: true });
  const replace = h('input', { type: 'radio', name: 'mode', value: 'replace' });
  return openSheet({
    title: `Import into ${def.name}`,
    subtitle: `Paste a JSON array, or choose a .json file. Records missing “${def.id_field}” get a generated one.`,
    submitLabel: 'Import',
    body: [
      file, ta,
      h('div', { class: 'radio-row', role: 'radiogroup', 'aria-label': 'Import mode' },
        h('label', {}, append, 'Add to existing records'),
        h('label', {}, replace, 'Replace all records')),
    ],
    onSubmit: async () => {
      let records;
      try { records = JSON.parse(ta.value); } catch (e) { throw new Error(`Invalid JSON: ${e.message}`); }
      if (!Array.isArray(records)) records = records?.[def.name] ?? records?.records;
      if (!Array.isArray(records)) throw new Error('Paste a JSON array of objects.');
      const r = await api('POST', `/__admin/resources/${def.name}/import`, { records, mode: replace.checked ? 'replace' : 'append' });
      toast(`Imported ${r.imported} record${r.imported === 1 ? '' : 's'}`);
      S.list.skip = 0;
      await loadResources();
      await loadList();
    },
  });
}

function resourceSettingsSheet(def) {
  const desc = h('input', { type: 'text', value: def.description || '' });
  const auth = h('input', { type: 'checkbox', checked: def.auth_required, role: 'switch' });
  const resetBtn = h('button', {
    class: 'btn', type: 'button',
    onclick: async () => {
      $('#sheet').close('cancel');
      const ok = await confirmSheet(def.builtin ? 'Restore Generated VMs?' : `Delete All Records in ${def.name}?`,
        def.builtin ? 'This replaces every VM, including your edits, with the original generated data.' : 'The resource stays, but all of its records are removed.',
        def.builtin ? 'Restore' : 'Delete All');
      if (!ok) return;
      try {
        await api('POST', `/__admin/resources/${def.name}/reset`, {});
        closeInspector(true);
        toast(def.builtin ? 'Restored generated VMs' : `Cleared ${def.name}`);
        await loadResources(); await loadList();
      } catch (e) { fail(e); }
    },
  }, def.builtin ? 'Restore Generated Data…' : 'Delete All Records…');
  const deleteBtn = def.builtin ? null : h('button', {
    class: 'btn danger', type: 'button',
    onclick: async () => {
      $('#sheet').close('cancel');
      const ok = await confirmSheet(`Delete the ${def.name} Resource?`, `/api/v1/${def.name} and all of its records will be removed. You can’t undo this.`, 'Delete Resource');
      if (!ok) return;
      try {
        await api('DELETE', `/__admin/resources/${def.name}`);
        closeInspector(true);
        toast(`Deleted ${def.name}`);
        await loadResources();
        location.hash = '#/r/vms';
      } catch (e) { fail(e); }
    },
  }, 'Delete Resource…');

  return openSheet({
    title: `${def.name} Settings`,
    subtitle: `ID field: ${def.id_field}`,
    submitLabel: 'Save',
    body: [
      h('label', { class: 'field' }, h('span', {}, 'Description'), desc),
      h('label', { class: 'switch' }, auth, h('span', {}, 'Private: callers need an API key, Basic login or OAuth token')),
      h('div', { class: 'radio-row' }, resetBtn, deleteBtn),
    ],
    onSubmit: async () => {
      await api('PATCH', `/__admin/resources/${def.name}`, { description: desc.value, auth_required: auth.checked });
      await loadResources();
      showResource(def.name);
      toast('Settings saved');
    },
  });
}

// ---------- Credentials ----------
const TYPE_INFO = {
  api_key: { label: 'API Key', short: 'API key', how: 'Sent as the X-API-Key header', secret: 'api_key' },
  basic: { label: 'Basic Auth', short: 'Basic', how: 'Username and password in an Authorization: Basic header', secret: 'password' },
  oauth_client: { label: 'OAuth Client', short: 'OAuth', how: 'Client ID and secret for /oauth/token, then a Bearer token', secret: 'client_secret' },
};
const PERM_LABEL = { read: 'Read', write: 'Write' };
const credFilter = { type: 'all' };

const resLabel = (r) => (r === '*' ? 'All collections' : r);
const autoScopes = (g) => (g.scope ? [g.scope] : g.permissions.map((p) => `${g.resource === '*' ? 'all' : g.resource}.${p}`));

async function showCredentials(collection = '') {
  if (!S.resources.length) await loadResources();
  const main = clear($('#main'));
  const colSelect = h('select', {
    'aria-label': 'Filter by collection',
    onchange: (ev) => { location.hash = ev.target.value ? `#/credentials/${encodeURIComponent(ev.target.value)}` : '#/credentials'; },
  }, h('option', { value: '' }, 'All collections'), S.resources.map((r) => h('option', { value: r.name, selected: r.name === collection ? 'selected' : null }, r.name)));
  const typeSeg = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Filter by type' },
    [['all', 'All'], ['api_key', 'API Keys'], ['basic', 'Basic'], ['oauth_client', 'OAuth']].map(([v, l]) => h('button', {
      type: 'button', 'aria-pressed': credFilter.type === v ? 'true' : 'false',
      onclick: () => { credFilter.type = v; showCredentials(collection); },
    }, l)));

  main.append(
    h('header', { class: 'toolbar' },
      sidebarButton(),
      h('div', { class: 'title' }, h('h1', {}, 'Credentials'),
        h('span', { class: 'secondary' }, 'API keys, Basic logins and OAuth clients for private collections.')),
      typeSeg, h('label', { class: 'select-wrap' }, colSelect),
      h('button', { class: 'btn primary', type: 'button', onclick: () => editCredential(null, collection) }, icon('plus'), 'New Credential')),
    h('div', { class: 'page wide-page', id: 'creds-page' }));
  await renderCredentials(collection);
}

async function renderCredentials(collection) {
  let data;
  try { data = await api('GET', '/__admin/credentials'); } catch (e) { return fail(e); }
  const page = $('#creds-page');
  if (!page) return;
  clear(page);

  const def = collection ? S.resources.find((r) => r.name === collection) : null;
  if (def && !def.auth_required) {
    page.append(h('section', { class: 'card' },
      h('div', { class: 'preview-head vm' }, icon('globe'), `${def.name} is public`),
      h('p', {}, 'Anyone can read and write it without credentials, so nothing below is checked for it. Make it private to require credentials.'),
      h('div', {}, h('button', {
        class: 'btn', type: 'button',
        onclick: async () => {
          try {
            await api('PATCH', `/__admin/resources/${def.name}`, { auth_required: true });
            await loadResources();
            toast(`${def.name} is now private`);
            showCredentials(collection);
          } catch (e) { fail(e); }
        },
      }, 'Make Private'))));
  }

  let creds = data.credentials;
  if (credFilter.type !== 'all') creds = creds.filter((c) => c.type === credFilter.type);
  if (collection) creds = creds.filter((c) => c.grants.some((g) => g.resource === '*' || g.resource === collection));

  const accessCell = (c) => h('div', { class: 'chips' }, c.grants.length
    ? c.grants.map((g) => h('span', { class: 'chip', title: c.type === 'oauth_client' ? `Scopes: ${autoScopes(g).join(' ')}` : null },
      h('b', {}, resLabel(g.resource)), ' · ', g.permissions.map((p) => PERM_LABEL[p]).join(', ')))
    : h('span', { class: 'error-text' }, 'No access'));
  const idCell = (c) => {
    if (c.type === 'api_key') return h('code', {}, `${c.key_prefix}…${c.secret_last4}`);
    if (c.type === 'basic') return h('span', { class: 'inline-copy' }, h('code', {}, c.username), copyButton(c.username, 'Copy username'));
    return h('span', { class: 'inline-copy' }, h('code', {}, c.client_id), copyButton(c.client_id, 'Copy client ID'));
  };
  const expiresCell = (c) => {
    if (!c.expires_at) return h('span', { class: 'tertiary' }, 'Never');
    const d = new Date(c.expires_at);
    return c.expired
      ? h('span', { class: 'error-text', title: d.toLocaleString() }, 'Expired')
      : h('span', { title: d.toLocaleString() }, d.toLocaleDateString());
  };
  const enabledCell = (c) => h('label', { class: 'switch', title: c.disabled ? 'Disabled' : 'Enabled' },
    h('input', {
      type: 'checkbox', role: 'switch', checked: !c.disabled, 'aria-label': `${c.label} enabled`,
      onchange: async (ev) => {
        try {
          await api('PATCH', `/__admin/credentials/${c.id}`, { disabled: !ev.target.checked });
          toast(ev.target.checked ? `Enabled ${c.label}` : `Disabled ${c.label}. Calls with it now get 401.`);
          renderCredentials(collection);
        } catch (e) { ev.target.checked = !ev.target.checked; fail(e); }
      },
    }));

  const rows = creds.map((c) => h('tr', { class: c.disabled || c.expired ? 'muted' : null },
    h('td', {}, h('div', { class: 'cred-name' }, h('span', {}, c.label), h('span', { class: `type-badge t-${c.type}` }, TYPE_INFO[c.type].short))),
    h('td', {}, idCell(c)),
    h('td', {}, accessCell(c)),
    h('td', {}, expiresCell(c)),
    h('td', {}, enabledCell(c)),
    h('td', {}, h('span', { class: 'tertiary', title: c.last_used_at || 'Never used' }, c.last_used_at ? relTime(c.last_used_at) : 'Never')),
    h('td', {}, h('div', { class: 'row-actions' },
      h('button', { class: 'btn small', type: 'button', onclick: () => editCredential(c, collection) }, 'Edit…'),
      h('button', { class: 'btn small', type: 'button', onclick: () => rotateCredential(c, collection) }, 'Rotate…'),
      h('button', { class: 'btn small danger', type: 'button', onclick: () => revokeCredential(c, collection) }, 'Revoke…')))));


  page.append(h('section', { class: 'card flush' },
    h('div', { class: 'table-scroll' }, h('table', { class: 'grid creds' },
      h('thead', {}, h('tr', {}, ['Name', 'Identifier', 'Access', 'Expires', 'Enabled', 'Last Used', ''].map((t) => h('th', { class: 'static', scope: 'col' }, t)))),
      h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colspan: '7', class: 'empty-cell' }, 'No credentials match these filters')))))));

  page.append(h('section', { class: 'card' },
    h('h2', {}, 'How Callers Use Them'),
    h('pre', { class: 'code' }, `# API key
curl -s "${location.origin}/api/v1/<collection>" -H "X-API-Key: $API_KEY"

# Basic auth
curl -s "${location.origin}/api/v1/<collection>" -u "$USERNAME:$PASSWORD"

# OAuth client (leave out scope to get every scope the client has)
curl -s -X POST ${location.origin}/oauth/token -u "$CLIENT_ID:$CLIENT_SECRET" \\
  -d grant_type=client_credentials -d scope="<collection>.read"
curl -s "${location.origin}/api/v1/<collection>" -H "Authorization: Bearer $ACCESS_TOKEN"`),
    h('p', { class: 'secondary' }, 'Credentials only apply to private collections. Disabling, editing access, rotating or revoking takes effect immediately and cancels existing OAuth tokens.')));
}

// Grants editor: rows of collection + permissions (+ scope name for OAuth).
function grantsEditor(state, isOAuth) {
  const wrap = h('div', { class: 'grants' });
  const preview = h('p', { class: 'secondary scope-preview' });
  const render = () => {
    clear(wrap);
    state.rows.forEach((row, i) => {
      const sel = h('select', {
        'aria-label': `Collection for row ${i + 1}`,
        onchange: (ev) => { row.resource = ev.target.value; updatePreview(); scopeInput && (scopeInput.placeholder = autoPlaceholder(row)); },
      },
      h('option', { value: '*', selected: row.resource === '*' ? 'selected' : null }, 'All collections'),
      S.resources.map((r) => h('option', { value: r.name, selected: row.resource === r.name ? 'selected' : null }, r.name + (r.auth_required ? '' : ' (public)'))));
      const perm = (p) => h('label', {}, h('input', {
        type: 'checkbox', checked: row[p],
        onchange: (ev) => { row[p] = ev.target.checked; updatePreview(); scopeInput && (scopeInput.placeholder = autoPlaceholder(row)); },
      }), PERM_LABEL[p]);
      const autoPlaceholder = (r) => autoScopes({ resource: r.resource, permissions: ['read', 'write'].filter((p) => r[p]) }).join(' ') || 'scope name';
      const scopeInput = isOAuth ? h('input', {
        type: 'text', class: 'mono', value: row.scope || '', placeholder: autoPlaceholder(row), 'aria-label': `Custom scope for row ${i + 1}`,
        spellcheck: 'false', autocomplete: 'off',
        oninput: (ev) => { row.scope = ev.target.value.trim(); updatePreview(); },
      }) : null;
      wrap.append(h('div', { class: `grant-row${isOAuth ? ' oauth' : ''}` },
        sel, h('div', { class: 'perm-toggle' }, perm('read'), perm('write')), scopeInput,
        h('button', {
          class: 'btn icon plain', type: 'button', 'aria-label': `Remove row ${i + 1}`, title: 'Remove', disabled: state.rows.length === 1,
          onclick: () => { state.rows.splice(i, 1); render(); },
        }, icon('close'))));
    });
    updatePreview();
  };
  const updatePreview = () => {
    if (!isOAuth) { preview.hidden = true; return; }
    const scopes = state.rows.flatMap((r) => autoScopes({ resource: r.resource, permissions: ['read', 'write'].filter((p) => r[p]), scope: r.scope }));
    preview.replaceChildren('Scopes this client can request: ', ...(scopes.length ? scopes.flatMap((sc, i) => [i ? ' ' : '', h('code', {}, sc)]) : ['none']));
  };
  render();
  return h('div', { class: 'field' },
    h('span', {}, 'Access'),
    isOAuth ? h('div', { class: 'grant-head oauth' }, h('span', {}, 'Collection'), h('span', {}, 'Permissions'), h('span', {}, 'Custom scope (optional)'), h('span')) : null,
    wrap,
    h('div', {}, h('button', {
      class: 'btn small', type: 'button',
      onclick: () => { state.rows.push({ resource: '*', read: true, write: false, scope: '' }); render(); },
    }, icon('plus'), 'Add Collection')),
    preview);
}

function expiryField(current) {
  const presets = [['', 'Never'], ['7', 'In 7 days'], ['30', 'In 30 days'], ['90', 'In 90 days'], ['365', 'In 1 year'], ['custom', 'On a date…']];
  const sel = h('select', { 'aria-label': 'Expires' },
    current ? h('option', { value: 'keep' }, `Keep current (${new Date(current).toLocaleDateString()})`) : null,
    presets.map(([v, l]) => h('option', { value: v }, l)));
  const date = h('input', { type: 'date', hidden: true, 'aria-label': 'Expiry date', min: new Date().toISOString().slice(0, 10) });
  sel.addEventListener('change', () => { date.hidden = sel.value !== 'custom'; if (!date.hidden) date.focus(); });
  const value = () => {
    if (sel.value === 'keep') return undefined;
    if (sel.value === '') return null;
    if (sel.value === 'custom') {
      if (!date.value) throw new Error('Choose an expiry date.');
      return new Date(`${date.value}T23:59:59`).toISOString();
    }
    return new Date(Date.now() + Number(sel.value) * 86400000).toISOString();
  };
  return { el: h('label', { class: 'field' }, h('span', {}, 'Expires'), h('div', { class: 'expiry-row' }, sel, date)), value };
}

async function editCredential(cred, collection) {
  const isNew = !cred;
  let type = cred?.type || 'api_key';
  const label = h('input', { type: 'text', maxlength: '80', value: cred?.label || '', placeholder: 'e.g. ServiceNow production', autocomplete: 'off' });
  const username = h('input', { type: 'text', class: 'mono', placeholder: 'Leave blank to generate one', autocomplete: 'off', spellcheck: 'false' });
  const ttl = h('input', { type: 'number', min: '30', max: '86400', step: '1', value: cred?.token_ttl_seconds ?? '', placeholder: `${S.info.oauth.token_ttl_seconds} (server default)` });
  const grantState = {
    rows: cred
      ? cred.grants.map((g) => ({ resource: g.resource, read: g.permissions.includes('read'), write: g.permissions.includes('write'), scope: g.scope || '' }))
      : [{ resource: collection || S.resources.find((r) => r.auth_required)?.name || '*', read: true, write: false, scope: '' }],
  };
  const expiry = expiryField(cred?.expires_at);
  const dynamic = h('div', { class: 'sheet-dynamic' });

  const renderDynamic = () => {
    append(clear(dynamic), [
      type === 'basic' && isNew ? h('label', { class: 'field' }, h('span', {}, 'Username'), username, h('span', { class: 'hint' }, 'The password is generated for you.')) : null,
      grantsEditor(grantState, type === 'oauth_client'),
      expiry.el,
      type === 'oauth_client' ? h('label', { class: 'field' }, h('span', {}, 'Token Lifetime (seconds)'), ttl, h('span', { class: 'hint' }, 'Between 30 and 86400. Short lifetimes are handy for testing token refresh.')) : null]);
  };

  const typePicker = isNew ? h('div', { class: 'type-picker', role: 'radiogroup', 'aria-label': 'Credential type' },
    Object.entries(TYPE_INFO).map(([t, info]) => h('label', { class: 'type-option' },
      h('input', { type: 'radio', name: 'cred-type', value: t, checked: t === type, onchange: () => { type = t; renderDynamic(); } }),
      h('span', { class: 'type-text' }, h('b', {}, info.label), h('span', { class: 'secondary' }, info.how))))) : null;
  renderDynamic();

  const result = await openSheet({
    title: isNew ? 'New Credential' : `Edit ${cred.label}`,
    subtitle: isNew ? 'Choose how callers sign in and which collections they can use.' : `${TYPE_INFO[type].label} · ${type === 'api_key' ? `${cred.key_prefix}…${cred.secret_last4}` : type === 'basic' ? cred.username : cred.client_id}`,
    submitLabel: isNew ? 'Create' : 'Save',
    wide: true,
    body: [typePicker, h('label', { class: 'field' }, h('span', {}, 'Name'), label), dynamic],
    onSubmit: async () => {
      const grants = grantState.rows.map((r) => ({
        resource: r.resource,
        permissions: ['read', 'write'].filter((p) => r[p]),
        ...(type === 'oauth_client' && r.scope ? { scope: r.scope } : {}),
      }));
      const body = { label: label.value.trim(), grants };
      const exp = expiry.value();
      if (exp !== undefined) body.expires_at = exp;
      if (type === 'oauth_client') body.token_ttl_seconds = ttl.value === '' ? null : Number(ttl.value);
      if (isNew) {
        body.type = type;
        if (type === 'basic' && username.value.trim()) body.username = username.value.trim();
        return api('POST', '/__admin/credentials', body);
      }
      return api('PATCH', `/__admin/credentials/${cred.id}`, body);
    },
  });
  if (!result || result === true) return;
  if (isNew) await showSecret(result, result[TYPE_INFO[result.type].secret], 'Created');
  else toast(`Saved ${result.label}`);
  renderCredentials(collection);
}

function secretField(label, value) {
  const id = `sec-${label.replace(/\W+/g, '-').toLowerCase()}`;
  return h('div', { class: 'field' },
    h('label', { for: id }, h('span', {}, label)),
    h('div', { class: 'secret-row' },
      h('input', { id, type: 'text', readonly: true, class: 'mono', value, spellcheck: 'false', onfocus: (e) => e.target.select() }),
      copyButton(value, `Copy ${label.toLowerCase()}`)));
}

function showSecret(cred, secret, verb) {
  const base = location.origin;
  let body;
  if (cred.type === 'api_key') {
    body = [secretField('API Key', secret), secretField('Header', `X-API-Key: ${secret}`)];
  } else if (cred.type === 'basic') {
    body = [secretField('Username', cred.username), secretField('Password', secret),
      secretField('Authorization Header', `Basic ${btoa(`${cred.username}:${secret}`)}`)];
  } else {
    body = [secretField('Client ID', cred.client_id), secretField('Client Secret', secret), secretField('Token URL', `${base}/oauth/token`),
      h('p', { class: 'secondary' }, 'Scopes: ', cred.scopes.flatMap((sc, i) => [i ? ' ' : '', h('code', {}, sc)]))];
  }
  return openSheet({
    title: `${verb} ${TYPE_INFO[cred.type].label}`,
    subtitle: `Copy the ${cred.type === 'basic' ? 'password' : cred.type === 'api_key' ? 'key' : 'secret'} now. It won’t be shown again.`,
    body, submitLabel: 'Done', cancelLabel: null, wide: true,
  });
}

async function rotateCredential(c, collection) {
  const what = c.type === 'basic' ? 'password' : c.type === 'api_key' ? 'key' : 'secret';
  const ok = await confirmSheet(`Rotate the ${what} for “${c.label}”?`,
    `You get a new ${what}. The current one${c.type === 'oauth_client' ? ', and every token issued with it,' : ''} stops working right away.`, 'Rotate');
  if (!ok) return;
  try {
    const r = await api('POST', `/__admin/credentials/${c.id}/rotate`, {});
    await showSecret(r, r[TYPE_INFO[r.type].secret], 'Rotated');
    renderCredentials(collection);
  } catch (e) { fail(e); }
}

async function revokeCredential(c, collection) {
  const ok = await confirmSheet(`Revoke “${c.label}”?`, 'Callers using it get 401 right away. You can’t undo this. To pause it instead, turn off Enabled.', 'Revoke');
  if (!ok) return;
  try {
    await api('DELETE', `/__admin/credentials/${c.id}`);
    toast(`Revoked ${c.label}`);
    renderCredentials(collection);
  } catch (e) { fail(e); }
}

// ---------- Connection page ----------
function showConnection() {
  const main = clear($('#main'));
  const o = S.info.oauth;
  const base = location.origin;
  const tokenUrl = base + o.token_path;

  const kvRow = (k, v, copy) => [h('dt', {}, k), h('dd', {}, v, copy ? copyButton(copy, `Copy ${k}`) : null)];
  const curl = `# 1. Get a token with an OAuth client from the Credentials page
curl -s -X POST ${tokenUrl} \\
  -u "$CLIENT_ID:$CLIENT_SECRET" \\
  -d grant_type=client_credentials -d scope=inventory.read

# 2. Call the API
curl -s "${base}/api/v1/vms?updated_since=2026-11-18T00:00:00Z&page=1&page_size=200" \\
  -H "Authorization: Bearer $ACCESS_TOKEN"`;

  main.append(
    h('header', { class: 'toolbar' }, sidebarButton(), h('div', { class: 'title' }, h('h1', {}, 'Connection'),
      h('span', { class: 'secondary' }, 'Use these values in ServiceNow, Postman or curl.'))),
    h('div', { class: 'page' },
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', {}, 'OAuth 2.0'),
          h('a', { class: 'btn small', href: '#/credentials' }, icon('key'), 'Manage Credentials')),
        h('dl', { class: 'kv' },
          kvRow('Token URL', h('code', {}, tokenUrl), tokenUrl),
          kvRow('Client ID & secret', h('span', { class: 'secondary' }, 'Create an OAuth client on the Credentials page. Its secret is shown once.')),
          kvRow('Grant type', h('code', {}, o.grant_type)),
          kvRow('Scopes', h('span', { class: 'secondary' }, 'Set per client: ', h('code', {}, '<collection>.read'), ', ', h('code', {}, '<collection>.write'), ' or your own names')),
          kvRow('Token lifetime', `${o.token_ttl_seconds} seconds by default, adjustable per client`),
          kvRow('Client auth', 'Basic header or form body'),
          kvRow('Rate limit', `${S.info.rate_limit.max} requests per ${S.info.rate_limit.window_seconds} s, per credential`))),
      h('section', { class: 'card' },
        h('h2', {}, 'Endpoints'),
        h('table', { class: 'grid' },
          h('thead', {}, h('tr', {}, ['Resource', 'Access', 'URL', ''].map((t) => h('th', { class: 'static', scope: 'col' }, t)))),
          h('tbody', {}, S.resources.map((r) => h('tr', {},
            h('td', {}, r.name),
            h('td', {}, r.auth_required ? 'Private' : 'Public'),
            h('td', { class: 'mono' }, `${base}/api/v1/${r.name}`),
            h('td', {}, copyButton(`${base}/api/v1/${r.name}`, `Copy ${r.name} URL`)))))),
        h('p', { class: 'secondary' },
          'List queries: ', h('code', {}, 'page'), ' and ', h('code', {}, 'page_size'), ' (max 200), or ',
          h('code', {}, 'limit'), ' and ', h('code', {}, 'skip'), ', plus ', h('code', {}, 'updated_since'), ', ',
          h('code', {}, 'q'), ', ', h('code', {}, 'sortBy'), ', ', h('code', {}, 'order'), ', ', h('code', {}, 'select'), ', ',
          h('code', {}, 'delay'), ', and any field, such as ', h('code', {}, 'status=running'), '. Private collections accept an ',
          h('code', {}, 'X-API-Key'), ' header, Basic credentials or a Bearer token. Create them on the ', h('a', { href: '#/credentials' }, 'Credentials'), ' page.')),
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', {}, 'Try It'), copyButton(curl, 'Copy commands')),
        h('pre', { class: 'code' }, curl)),
      h('section', { class: 'card' },
        h('h2', {}, 'ServiceNow Setup'),
        h('ol', { class: 'steps' },
          h('li', {}, 'Create an OAuth client on the Credentials page with read access to vms and the custom scope inventory.read. Then in ServiceNow: System OAuth › Application Registry › New › Connect to a third party OAuth Provider. Enter that client ID and secret, set the default grant type to Client Credentials, and set the token URL above.'),
          h('li', {}, 'On the OAuth Entity Profile, add the scope ', h('code', {}, 'inventory.read'), '.'),
          h('li', {}, 'Create a Connection & Credential Alias, an HTTP(S) Connection with the base URL, and an OAuth 2.0 Credential that uses that profile.'),
          h('li', {}, 'In the Data Stream action, call ', h('code', {}, 'GET /api/v1/vms'), ' and paginate until ', h('code', {}, 'page == total_pages'), '.')))));
}

// ---------- Test controls ----------
async function showControls() {
  const main = clear($('#main'));
  main.append(
    h('header', { class: 'toolbar' }, sidebarButton(), h('div', { class: 'title' }, h('h1', {}, 'Test Controls'),
      h('span', { class: 'secondary' }, 'Make the API misbehave on purpose so you can test the integration’s error handling.'))),
    h('div', { class: 'page', id: 'controls-page' }));
  await renderControls();
}

async function renderControls() {
  let st;
  try { st = await api('GET', '/__admin/state'); } catch (e) { return fail(e); }
  const page = clear($('#controls-page'));
  const chaosRow = (key, title, desc, max, unit) => {
    const inp = h('input', { type: 'number', min: '0', max: String(max), step: key === 'delay_ms' ? '100' : '1', value: st.chaos[key], 'aria-label': title });
    const apply = h('button', {
      class: 'btn', type: 'button',
      onclick: async () => {
        try {
          const r = await api('POST', '/__admin/chaos', { [key]: Number(inp.value) || 0 });
          inp.value = r.chaos[key];
          toast(r.chaos[key] ? `${title}: ${r.chaos[key]}${unit}` : `${title}: off`);
        } catch (e) { fail(e); }
      },
    }, 'Apply');
    inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') apply.click(); });
    return h('div', { class: 'control' },
      h('div', { class: 'desc' }, h('h3', {}, title), h('p', { class: 'secondary' }, desc)),
      h('div', { class: 'stepper' }, inp, unit ? h('span', { class: 'secondary' }, unit.trim()) : null, apply));
  };
  const touchCount = h('input', { type: 'number', min: '1', max: '450', value: '5', 'aria-label': 'Number of VMs to mark as changed' });

  page.append(
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Traffic So Far'),
        h('button', { class: 'btn small', type: 'button', onclick: renderControls }, 'Refresh')),
      h('div', { class: 'stats' },
        h('span', {}, h('b', {}, st.stats.token_issued), ' tokens issued'),
        h('span', {}, h('b', {}, st.stats.token_rejected), ' token requests rejected'),
        h('span', {}, h('b', {}, st.active_tokens), ' active tokens'),
        h('span', {}, h('b', {}, st.stats.api_ok), ' successful list calls'),
        h('span', {}, h('b', {}, st.stats.api_401), ' × 401'),
        h('span', {}, h('b', {}, st.stats.api_429), ' × 429'),
        h('span', {}, h('b', {}, st.stats.api_5xx), ' × 5xx'))),
    h('section', { class: 'controls', 'aria-label': 'Failure simulation' },
      chaosRow('unauthorized_next', 'Fail With 401', 'The next N OAuth calls get 401 invalid_token. The integration should get a new token and retry once.', 100, ''),
      chaosRow('rate_limit_next', 'Fail With 429', 'The next N OAuth calls get 429 with Retry-After: 2. The integration should wait, then retry.', 100, ''),
      chaosRow('server_error_next', 'Fail With 503', 'The next N OAuth calls get 503. The run should fail and leave last_successful_run unchanged.', 100, ''),
      chaosRow('delay_ms', 'Slow Responses', 'Adds this delay to every OAuth and public call.', 30000, ' ms')),
    h('section', { class: 'controls', 'aria-label': 'Data and token actions' },
      h('div', { class: 'control' },
        h('div', { class: 'desc' }, h('h3', {}, 'Mark VMs as Changed'), h('p', { class: 'secondary' }, 'Sets updated time and last_seen to now on random VMs, so the next delta run picks up only those.')),
        h('div', { class: 'stepper' }, touchCount, h('button', {
          class: 'btn', type: 'button',
          onclick: async () => {
            try {
              const r = await api('POST', '/__admin/touch', { count: Number(touchCount.value) || 5 });
              toast(`Marked ${r.touched.length} VMs as changed`);
            } catch (e) { fail(e); }
          },
        }, 'Mark'))),
      h('div', { class: 'control' },
        h('div', { class: 'desc' }, h('h3', {}, 'Revoke All Tokens'), h('p', { class: 'secondary' }, 'Every issued token stops working. The next call gets a real 401.')),
        h('button', {
          class: 'btn', type: 'button',
          onclick: async () => { try { const r = await api('POST', '/__admin/revoke-tokens', {}); toast(`Revoked ${r.revoked} token${r.revoked === 1 ? '' : 's'}`); renderControls(); } catch (e) { fail(e); } },
        }, 'Revoke')),
      h('div', { class: 'control' },
        h('div', { class: 'desc' }, h('h3', {}, 'Reset Everything'), h('p', { class: 'secondary' }, 'Restores the generated VMs and clears tokens, counters, failure settings and the request log. Custom resources are kept.')),
        h('button', {
          class: 'btn danger', type: 'button',
          onclick: async () => {
            const ok = await confirmSheet('Reset Everything?', 'Your VM edits will be lost. Custom resources are kept.', 'Reset');
            if (!ok) return;
            try { await api('POST', '/__admin/reset', {}); closeInspector(true); await loadResources(); toast('Reset complete'); renderControls(); } catch (e) { fail(e); }
          },
        }, 'Reset…'))));
}

// ---------- Request log ----------
function showLog() {
  const main = clear($('#main'));
  main.append(
    h('header', { class: 'toolbar' }, sidebarButton(),
      h('div', { class: 'title' }, h('h1', {}, 'Request Log'), h('span', { class: 'secondary' }, 'Latest API calls, newest first. Refreshes every 3 seconds.')),
),
    h('div', { class: 'table-wrap', id: 'log-wrap' }));
  renderLog();
  S.logTimer = setInterval(() => { if (!document.hidden) renderLog(); }, 3000);
}
async function renderLog() {
  let st;
  try { st = await api('GET', '/__admin/state'); } catch { return; }
  const wrap = $('#log-wrap');
  if (!wrap) return;
  const rows = st.recent_requests;
  clear(wrap);
  if (!rows.length) {
    wrap.append(h('div', { class: 'empty' }, icon('list'), h('h2', {}, 'No API calls yet'),
      h('p', { class: 'secondary' }, 'Calls from ServiceNow, Postman or curl appear here as they arrive.')));
    return;
  }
  wrap.append(h('table', { class: 'grid', 'aria-label': 'Recent requests' },
    h('thead', {}, h('tr', {}, ['Time', 'Method', 'Path', 'Status', 'Duration', 'Caller'].map((t) => h('th', { class: 'static', scope: 'col' }, t)))),
    h('tbody', {}, rows.map((r) => h('tr', {},
      h('td', { class: 'tertiary', title: r.at }, new Date(r.at).toLocaleTimeString()),
      h('td', { class: 'mono' }, r.method),
      h('td', { class: 'mono', title: r.path + (r.query || '') }, r.path, h('span', { class: 'tertiary' }, decodeURIComponent(r.query || ''))),
      h('td', {}, h('span', { class: `status s${String(r.status)[0]} s${r.status}` }, r.status)),
      h('td', { class: 'tertiary' }, `${r.ms} ms`),
      h('td', {}, h('span', { class: 'actor' }, ({ oauth: 'OAuth', api_key: 'API key', basic: 'Basic', admin: 'Admin key' })[r.actor] || 'Public')))))));
}

// ---------- Utilities ----------
function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
function relTime(iso) {
  if (!iso) return '—';
  const s = (new Date(iso) - Date.now()) / 1000;
  const a = Math.abs(s);
  if (a < 60) return rtf.format(Math.round(s), 'second');
  if (a < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (a < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  return rtf.format(Math.round(s / 86400), 'day');
}

// ---------- Keyboard ----------
document.addEventListener('keydown', (ev) => {
  if ($('#app').hidden || $('#sheet').open) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
  if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 's' && S.insp) { ev.preventDefault(); saveRecord(); return; }
  if (ev.key === 'Escape' && S.insp) { ev.preventDefault(); closeInspector(); return; }
  if (typing || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (ev.key === '/' && $('#search')) { ev.preventDefault(); $('#search').focus(); }
  if (ev.key === 'n' && S.route.view === 'resource') { ev.preventDefault(); newRecord(); }
});
window.addEventListener('beforeunload', (ev) => { if (S.insp?.dirty && !S.insp.isNew) ev.preventDefault(); });

// ---------- Start ----------
boot().catch((e) => {
  $('#main').replaceChildren(h('div', { class: 'empty' }, icon('warn'), h('h2', {}, 'Can’t reach the server'), h('p', { class: 'secondary' }, e.message)));
  $('#app').hidden = false;
});
