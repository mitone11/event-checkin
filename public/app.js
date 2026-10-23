const API = '';
let guests = [];
let filter = 'all';
let selectedCI = null;
let selectedInvitante = null;
let currentPostazione = null;



async function loadData() {
  try {
    const [gRes, sRes] = await Promise.all([
      fetch(API + '/api/guests'),
      fetch(API + '/api/stats')
    ]);
    guests = await gRes.json();
    const stats = await sRes.json();
    document.getElementById('stat-total').textContent = stats.total;
    document.getElementById('stat-entered').textContent = stats.entered;
    document.getElementById('stat-pending').textContent = stats.pending;
    document.getElementById('stat-pct').textContent = stats.total > 0 ? Math.round(stats.entered / stats.total * 100) + '%' : '0%';
    renderList();
    if (selectedCI) renderDetail(selectedCI);
    // FIX: aggiorna la vista gruppo dopo ogni refresh automatico
    if (selectedInvitante && !selectedCI) renderInvitanteDetail(selectedInvitante);
  } catch(e) {
    showToast('Errore connessione al server', 'error');
  }
}

function setFilter(f, el) {
  filter = f;
  selectedInvitante = null;
  document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  renderList();
  if (selectedCI) renderDetail(selectedCI);
}

function getInitials(nome, cognome) {
  const first = (nome || '').trim()[0] || '?';
  const second = (cognome || '').trim()[0] || '';
  return (first + second).toUpperCase();
}

function getTableLabel(g) {
  const tableNumber = (g.numero_tavolo || '').trim();
  return tableNumber ? 'Tavolo ' + tableNumber : 'Tavolo non assegnato';
}

function showCheckinTables(checkedGuests) {
  if (!checkedGuests.length) return;
  const ul = document.getElementById('tables-modal-list');
  ul.innerHTML = checkedGuests.map(g =>
    `<li>${g.nome} ${g.cognome} &mdash; <strong>${getTableLabel(g)}</strong></li>`
  ).join('');
  document.getElementById('tables-modal').classList.add('show');
}

function closeTablesModal() {
  document.getElementById('tables-modal').classList.remove('show');
  loadData();
}

function renderList() {
  const q = document.getElementById('search').value.toLowerCase().trim();
  const list = document.getElementById('guest-list');

  let filtered = guests.filter(g => {
    const haystack = [g.nome, g.cognome, g.codice_carta_identita, g.invitante, g.numero_tavolo].filter(Boolean).join(' ').toLowerCase();
    const match = !q || haystack.includes(q);
    if (!match) return false;
    if (filter === 'pending') return !g.checkin;
    if (filter === 'done') return !!g.checkin;
    return true;
  });

  if (filter === 'group') {
    const groups = {};
    filtered.forEach(g => {
      const key = g.invitante || 'Senza invitante';
      if (!groups[key]) groups[key] = [];
      groups[key].push(g);
    });
    list.innerHTML = Object.entries(groups).map(([inv, items]) => {
      const entered = items.filter(i => i.checkin).length;
      const pending = items.filter(i => !i.checkin).length;
      const selected = selectedInvitante === inv ? 'selected' : '';
      return `<div class="group-section ${selected}">
        <div class="group-header">
          <span onclick="selectInvitante(${JSON.stringify(inv).replace(/"/g,'&quot;')})" style="cursor:pointer">${inv}</span>
          <div class="group-actions">
            <span class="group-count">${entered}/${items.length}</span>
            <button class="mini-btn"
              data-invitante="${inv.replace(/"/g, '&quot;')}"
              onclick="event.stopPropagation(); bulkCheckinFromBtn(this)"
              ${pending === 0 || !currentPostazione ? 'disabled' : ''}
              title="${!currentPostazione ? 'Seleziona prima una postazione' : pending === 0 ? 'Tutti già registrati' : 'Registra tutti gli arrivi del gruppo'}">Flag arrivo tutti</button>
          </div>
        </div>
        ${items.map(g => guestItemHTML(g)).join('')}
      </div>`;
    }).join('');
    if (!list.innerHTML) list.innerHTML = '<div class="empty-state" style="height:auto;padding:2rem 1rem"><p>Nessun invitante trovato</p></div>';
  } else {
    list.innerHTML = filtered.map(g => guestItemHTML(g)).join('');
    if (!list.innerHTML) list.innerHTML = '<div class="empty-state" style="height:auto;padding:2rem 1rem"><p>Nessun invitato trovato</p></div>';
  }
}

function guestItemHTML(g) {
  const done = !!g.checkin;
  const sel = g.codice_carta_identita === selectedCI ? 'selected' : '';
  return `<div class="guest-item ${sel}" onclick="selectGuest('${g.codice_carta_identita}')">
    <div class="avatar ${done ? 'done' : 'pending'}">${getInitials(g.nome, g.cognome)}</div>
    <div class="guest-info">
      <div class="guest-name">${g.nome} ${g.cognome}</div>
      <div class="guest-sub">${done ? '&#x2713; Entrato &mdash; ' + g.checkin.postazione : 'Invitato da: ' + g.invitante}</div>
    </div>
    <div class="status-dot ${done ? 'green' : 'gray'}"></div>
  </div>`;
}

function selectGuest(ci) {
  selectedCI = ci;
  const guest = guests.find(x => x.codice_carta_identita === ci);
  selectedInvitante = guest ? (guest.invitante || null) : selectedInvitante;
  renderList();
  renderDetail(ci);
  document.getElementById('empty-state').style.display = 'none';
  document.getElementById('detail-view').style.display = 'block';
}

function selectInvitante(invitante) {
  selectedInvitante = invitante;
  selectedCI = null;
  renderList();
  renderInvitanteDetail(invitante);
  document.getElementById('empty-state').style.display = 'none';
  document.getElementById('detail-view').style.display = 'block';
}

function renderDetail(ci) {
  const g = guests.find(x => x.codice_carta_identita === ci);
  if (!g) return;
  const done = !!g.checkin;
  const v = document.getElementById('detail-view');
  v.innerHTML = `
    <div class="detail-card">
      <div class="detail-header">
        <div class="detail-avatar">${getInitials(g.nome, g.cognome)}</div>
        <div>
          <div class="detail-name">${g.nome} ${g.cognome}</div>
          <div class="detail-ci">${g.codice_carta_identita}</div>
        </div>
      </div>
      <div class="detail-grid">
        <div class="detail-field">
          <label>Invitato da</label>
          <p>${g.invitante}</p>
        </div>
        <div class="detail-field">
          <label>Stato</label>
          <p style="color: ${done ? 'var(--green)' : 'var(--muted)'}">${done ? 'Entrato' : 'Non ancora entrato'}</p>
        </div>
        <div class="detail-field">
          <label>Numero tavolo</label>
          <p>${getTableLabel(g)}</p>
        </div>
      </div>
    </div>

    <div class="checkin-status ${done ? 'done' : 'pending'}">
      <div class="icon">${done ? '&#x2705;' : '&#x23F3;'}</div>
      <div>
        <h3>${done ? 'Check-in effettuato' : 'In attesa di ingresso'}</h3>
        <p>${done ? 'Ore ' + new Date(g.checkin.timestamp).toLocaleTimeString('it-IT') + ' &mdash; ' + g.checkin.postazione : 'Non ancora registrato'}</p>
      </div>
    </div>

    ${!done ? `<button class="btn btn-checkin" onclick="doCheckin('${g.codice_carta_identita}')" ${!currentPostazione ? 'disabled title="Seleziona prima una postazione"' : ''}>
      &#x2713; Registra ingresso ${currentPostazione ? '&mdash; ' + currentPostazione : ''}
    </button>` : `<button class="btn btn-undo" onclick="undoCheckin('${g.codice_carta_identita}')">Annulla ingresso</button>`}
  `;
}

function renderInvitanteDetail(invitante) {
  const items = guests.filter(x => (x.invitante || 'Senza invitante') === invitante);
  if (!items.length) return;
  const entered = items.filter(x => x.checkin).length;
  const pendingItems = items.filter(x => !x.checkin);
  const v = document.getElementById('detail-view');
  v.innerHTML = `
    <div class="detail-card">
      <div class="detail-header">
        <div class="detail-avatar">${invitante.split(' ').map(x => x[0] || '').slice(0,2).join('').toUpperCase() || 'I'}</div>
        <div>
          <div class="detail-name">${invitante}</div>
          <div class="detail-ci">Gruppo invitante</div>
        </div>
      </div>
      <div class="detail-grid">
        <div class="detail-field">
          <label>Totale invitati</label>
          <p>${items.length}</p>
        </div>
        <div class="detail-field">
          <label>Entrati</label>
          <p style="color: var(--green)">${entered}</p>
        </div>
        <div class="detail-field">
          <label>In attesa</label>
          <p style="color: var(--amber)">${pendingItems.length}</p>
        </div>
        <div class="detail-field">
          <label>Postazione corrente</label>
          <p>${currentPostazione || 'Non selezionata'}</p>
        </div>
      </div>
    </div>

    <div class="checkin-status ${pendingItems.length ? 'pending' : 'done'}">
      <div class="icon">${pendingItems.length ? '&#x1F465;' : '&#x2705;'}</div>
      <div>
        <h3>${pendingItems.length ? 'Arrivi di gruppo disponibili' : 'Tutti gli invitati sono già entrati'}</h3>
        <p>${pendingItems.length ? pendingItems.length + ' invitati ancora da registrare' : 'Nessuna azione necessaria'}</p>
      </div>
    </div>

    <div class="detail-actions">
      <button class="btn btn-checkin" onclick='bulkCheckin(${JSON.stringify(invitante)}, false)' ${!pendingItems.length || !currentPostazione ? 'disabled title="Seleziona prima una postazione"' : ''}>
        &#x2713; Registra tutti gli arrivi ${currentPostazione ? '&mdash; ' + currentPostazione : ''}
      </button>
      <button class="btn btn-secondary" onclick="focusFirstPending(${JSON.stringify(invitante)})" ${!pendingItems.length ? 'disabled' : ''}>Apri primo invitato in attesa</button>
    </div>
  `;
}

function focusFirstPending(invitante) {
  const first = guests.find(x => (x.invitante || 'Senza invitante') === invitante && !x.checkin);
  if (first) selectGuest(first.codice_carta_identita);
}

// Wrapper sicuro per il bottone inline nella lista gruppi (legge il nome dal data-attribute)
function bulkCheckinFromBtn(btn) {
  const invitante = btn.getAttribute('data-invitante');
  if (!invitante) return;
  bulkCheckin(invitante, true);
}

async function bulkCheckin(invitante, silent) {
  if (!currentPostazione) { showToast('Seleziona prima una postazione', 'error'); return; }
  const pending = guests.filter(x => (x.invitante || 'Senza invitante') === invitante && !x.checkin);
  if (!pending.length) { showToast('Tutti già registrati', 'error'); return; }
  const checkedGuests = [];
  let ok = 0;
  let failed = 0;
  for (const guest of pending) {
    try {
      const res = await fetch(API + '/api/checkin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codice_carta_identita: guest.codice_carta_identita, postazione: currentPostazione })
      });
      const data = await res.json().catch(() => null);
      if (res.ok) {
        ok++;
        checkedGuests.push(data && data.guest ? data.guest : guest);
      } else {
        failed++;
      }
    } catch (e) {
      failed++;
    }
  }
  await loadData();
  selectedInvitante = invitante;
  renderInvitanteDetail(invitante);
  showToast((silent ? '' : 'Gruppo ' + invitante + ': ') + ok + ' registrati' + (failed ? ', ' + failed + ' non riusciti' : ''), failed ? 'error' : 'success');
  showCheckinTables(checkedGuests);
}

async function doCheckin(ci) {
  if (!currentPostazione) { showToast('Seleziona prima una postazione', 'error'); return; }
  try {
    const res = await fetch(API + '/api/checkin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ codice_carta_identita: ci, postazione: currentPostazione })
    });
    const data = await res.json();
    if (res.ok) {
      showToast('&#x2713; ' + data.guest.nome + ' ' + data.guest.cognome + ' registrato!', 'success');
      showCheckinTables([data.guest]);
      loadData();
    } else if (res.status === 409) {
      showToast('Invitato già registrato', 'error');
    } else {
      showToast(data.error || 'Errore', 'error');
    }
  } catch(e) {
    showToast('Errore di rete', 'error');
  }
}

async function undoCheckin(ci) {
  if (!confirm('Annullare il check-in?')) return;
  try {
    const res = await fetch(API + '/api/checkin/' + ci, { method: 'DELETE' });
    if (res.ok) {
      showToast('Check-in annullato', 'success');
      loadData();
    }
  } catch(e) {
    showToast('Errore di rete', 'error');
  }
}

function openPostazioneModal() {
  document.getElementById('postazione-modal').classList.add('show');
  if (currentPostazione) document.getElementById('postazione-select').value = currentPostazione;
}
function closePostazioneModal() {
  document.getElementById('postazione-modal').classList.remove('show');
}
function confirmPostazione() {
  currentPostazione = document.getElementById('postazione-select').value;
  document.getElementById('postazione-label').textContent = currentPostazione;
  closePostazioneModal();
  if (selectedCI) renderDetail(selectedCI);
  if (selectedInvitante) renderInvitanteDetail(selectedInvitante);
  renderList();
}

function showToast(msg, type) {
  const t = document.getElementById('toast');
  t.innerHTML = msg;
  t.className = 'toast show ' + (type || '');
  setTimeout(() => t.className = 'toast', 3500);
}

// ── ASSISTENZA URGENTE (TELEGRAM) ───────────────────────────
const TG_TOKEN = '8548050959:AAFBCdM5b1E_f00PdzffKhV2z1XM0PVlVsY';
const TG_CHAT_ID = '1036817997';

async function sendSOS() {
  const btn = document.getElementById('sos-btn');
  const postazione = currentPostazione || 'non selezionata';
  const msg = `🚨 Assistenza urgente richiesta alla ${postazione}`;

  btn.disabled = true;
  btn.textContent = '⏳ Invio...';

  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text: msg })
    });
    const data = await res.json();
    if (data.ok) {
      showToast('🚨 Assistenza allertata via Telegram!', 'success');
      btn.textContent = '✓ Inviato';
      setTimeout(() => {
        btn.textContent = '🚨 Assistenza urgente';
        btn.disabled = false;
      }, 5000);
    } else {
      throw new Error(data.description || 'Errore Telegram');
    }
  } catch(e) {
    showToast('Errore invio SOS: ' + e.message, 'error');
    btn.textContent = '🚨 Assistenza urgente';
    btn.disabled = false;
  }
}
// ────────────────────────────────────────────────────────────

// ── AUTENTICAZIONE ──────────────────────────────────────────
// Cambia questa stringa con la password che vuoi usare
const PASSWORD = 'mak2024';
const SESSION_KEY = 'mak_auth';

function tryLogin() {
  const input = document.getElementById('login-input');
  const errorEl = document.getElementById('login-error');
  if (input.value === PASSWORD) {
    sessionStorage.setItem(SESSION_KEY, '1');
    document.getElementById('login-overlay').classList.add('hidden');
    loadData();
  } else {
    errorEl.textContent = 'Password errata. Riprova.';
    input.value = '';
    input.classList.add('error');
    input.focus();
    setTimeout(() => input.classList.remove('error'), 400);
  }
}

function checkAuth() {
  if (sessionStorage.getItem(SESSION_KEY) === '1') {
    document.getElementById('login-overlay').classList.add('hidden');
    return true;
  }
  return false;
}
// ────────────────────────────────────────────────────────────

setInterval(loadData, 10000);
if (checkAuth()) {
  loadData();
}