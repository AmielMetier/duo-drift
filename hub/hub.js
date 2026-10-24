/* Hub : profil, salon commun et lancement des jeux dans une iframe.
   Le salon (DDRoom) vit ici pendant toute la session : changer de jeu ne coupe pas la connexion. */
(function () {
  const VERSION = '2.42';
  const $ = (s) => document.querySelector(s);
  const ORIGIN = location.origin === 'null' ? '*' : location.origin;
  const GAMES = window.HUB_GAMES;
  const gameDef = (id) => GAMES.find((g) => g.id === id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  let me = DDProfile.load();
  let room = null;
  let frame = null;        // { game, n, el, loaded }
  let leftGame = null;     // partie quittée volontairement (pas de rechargement automatique)
  const pick = { game: GAMES[0].id, settings: {} };
  for (const g of GAMES) {
    pick.settings[g.id] = {};
    for (const s of g.settings || []) pick.settings[g.id][s.key] = DDProfile.get('hub_set_' + g.id + '_' + s.key, s.def);
  }

  function showScreen(id) { for (const s of document.querySelectorAll('.screen')) s.classList.toggle('on', s.id === id); document.dispatchEvent(new CustomEvent('hub:screen', { detail: id })); }
  let toastT = 0;
  function toast(msg, ms = 2800) {
    let t = $('.toast'); if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, ms);
  }

  /* ------------------------------------------------------------ accueil */
  $('#ver').textContent = 'v' + VERSION;
  $('#shelf').innerHTML = GAMES.map((g) => `<div class="mini"><div class="cv">${g.cover}</div><div><b>${esc(g.title)}</b><small>${esc(g.tag)} · ${g.minPlayers === 1 ? 'seul ou' : g.minPlayers + ' à'} ${g.maxPlayers} joueurs</small></div></div>`).join('');
  $('#name').value = me.name;
  $('#name').addEventListener('input', (e) => { me.name = e.target.value.slice(0, 12); DDProfile.save(me); if (room) room.updateMe(me); });
  function renderSwatches() {
    const box = $('#swatches'); box.innerHTML = '';
    for (const c of DDProfile.PALETTE) {
      const b = document.createElement('button'); b.className = 'sw' + (c === me.color ? ' sel' : ''); b.style.background = c;
      b.setAttribute('aria-label', 'Couleur ' + c); b.onclick = () => { me.color = c; DDProfile.save(me); renderSwatches(); };
      box.appendChild(b);
    }
  }
  renderSwatches();
  const joinParam = new URLSearchParams(location.search).get('join');
  if (joinParam) { $('#joinCode').value = joinParam.toUpperCase().slice(0, 4); }
  $('#joinCode').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
  $('#joinCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btnJoin').click(); });
  const homeErr = (m) => { $('#homeErr').textContent = m || ''; };

  /* ------------------------------------------------------------ test de connexion */
  function openNetTest() {
    const ov = document.createElement('div'); ov.className = 'ntov';
    ov.innerHTML = `<div class="nt card" role="dialog" aria-label="Test de connexion"><button class="ntx" aria-label="Fermer">×</button>
      <h2>Test de connexion</h2><p class="nthint">Une vingtaine de secondes. Lance-le sur le réseau où le multijoueur ne marche pas.</p>
      <ul class="ntlist"></ul><div class="ntverdict" hidden></div>
      <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn small ghost" id="ntCopy" hidden>Copier le résultat</button><button class="btn small" id="ntAgain" hidden>Recommencer</button></div></div>`;
    document.body.appendChild(ov);
    const close = () => ov.remove();
    ov.querySelector('.ntx').onclick = close;
    ov.addEventListener('pointerdown', (e) => { if (e.target === ov) close(); });
    const list = ov.querySelector('.ntlist');
    let lines = [];
    const go = async () => {
      list.innerHTML = ''; lines = [];
      ov.querySelector('.ntverdict').hidden = true; ov.querySelector('#ntCopy').hidden = true; ov.querySelector('#ntAgain').hidden = true;
      const R = await DDNetTest.run((key, label, v) => {
        let li = list.querySelector(`[data-k="${key}"]`);
        if (!li) { li = document.createElement('li'); li.dataset.k = key; list.appendChild(li); }
        li.className = v === null ? 'wait' : v ? 'ok' : 'ko';
        li.innerHTML = `<i></i><span></span><b>${v === null ? 'test…' : v ? 'OK' : 'bloqué'}</b>`;
        li.querySelector('span').textContent = label;
        if (v !== null) lines.push(`${label} : ${v ? 'OK' : 'bloqué'}`);
      });
      const vd = DDNetTest.verdict(R), box = ov.querySelector('.ntverdict');
      box.hidden = false; box.className = 'ntverdict ' + (vd.ok ? 'ok' : 'ko'); box.textContent = vd.text;
      lines.push('', vd.text, '', navigator.userAgent);
      ov.querySelector('#ntCopy').hidden = false; ov.querySelector('#ntAgain').hidden = false;
    };
    ov.querySelector('#ntAgain').onclick = go;
    ov.querySelector('#ntCopy').onclick = () => {
      const txt = 'Test de connexion Game Hub\n' + lines.join('\n');
      (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(() => toast('Résultat copié'), () => toast('Copie impossible : fais une capture d\'écran'));
    };
    go();
  }
  $('#btnNetTest').onclick = openNetTest;

  /* ------------------------------------------------------------ nouveautés (journal des versions) */
  // Le journal est lu dans CHANGELOG.md : une seule source, toujours à jour.
  function mdInline(s) {
    return esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>');
  }
  function parseChangelog(md) {
    const out = []; let cur = null, item = null;
    for (const line of md.split('\n')) {
      const h = /^## (.+)$/.exec(line);
      if (h) { cur = { title: h[1], items: [] }; out.push(cur); item = null; continue; }
      if (!cur) continue;
      const li = /^(\s*)- (.+)$/.exec(line);
      if (li) { item = { text: li[2], sub: li[1].length >= 2 }; cur.items.push(item); continue; }
      if (item && /^\s+\S/.test(line)) item.text += ' ' + line.trim();
    }
    return out;
  }
  async function openNews() {
    const ov = document.createElement('div'); ov.className = 'ntov';
    ov.innerHTML = '<div class="nt card news" role="dialog" aria-label="Nouveautés"><button class="ntx" aria-label="Fermer">×</button><h2>✨ Nouveautés</h2><div class="newsbody"><p class="nthint">Chargement…</p></div>'
      + '<div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn" id="newsOk">Compris !</button></div></div>';
    document.body.appendChild(ov);
    const close = () => { ov.remove(); DDProfile.set('hub_seen_ver', VERSION); };
    ov.querySelector('.ntx').onclick = close; ov.querySelector('#newsOk').onclick = close;
    ov.addEventListener('pointerdown', (e) => { if (e.target === ov) close(); });
    let vers = [];
    try { vers = parseChangelog(await (await fetch('CHANGELOG.md', { cache: 'no-cache' })).text()); } catch (e) {}
    const body = ov.querySelector('.newsbody');
    if (!vers.length) { body.innerHTML = '<p class="nthint">Journal indisponible pour le moment.</p>'; return; }
    const block = (v, open) => `<details class="ver" ${open ? 'open' : ''}><summary>${mdInline(v.title)}${v.title.startsWith(VERSION + ' ') ? ' <span class="pill">actuelle</span>' : ''}</summary>
      <ul>${v.items.map((it) => `<li class="${it.sub ? 'sub' : ''}">${mdInline(it.text)}</li>`).join('')}</ul></details>`;
    body.innerHTML = vers.map((v, k) => block(v, k < 2)).join('');
  }
  $('#btnNews').onclick = openNews;
  $('#ver').onclick = openNews;
  // à la première visite après une mise à jour (pas pour un tout nouveau joueur)
  {
    const seen = DDProfile.get('hub_seen_ver', null), veteran = seen || DDProfile.get('dd_seen_ver', null) || DDProfile.get('dd_name', null);
    if (!seen && !veteran) DDProfile.set('hub_seen_ver', VERSION);
    else if (seen !== VERSION && !new URLSearchParams(location.search).has('join')) setTimeout(openNews, 600);
  }

  /* ------------------------------------------------------------ classement entre potes */
  // Le jeu de l'hôte (ou du joueur solo) signale la fin d'une partie ; on relie ses joueurs aux identifiants du salon.
  function recordResult(game, r) {
    if (!room || !r || !Array.isArray(r.players) || !(room.isHost || room.mode === 'solo')) return;
    const byId = new Map(room.players.map((p) => [p.id, p])), byName = new Map(room.players.map((p) => [p.name, p]));
    const players = r.players.map((p) => {
      const hp = p.bot ? null : (Number.isInteger(p.id) && byId.get(p.id)) || byName.get(p.name);
      return { key: p.bot ? 'bot:' + p.name : hp && hp.uid ? hp.uid : 'nom:' + p.name, name: hp ? hp.name : p.name, color: p.color || (hp && hp.color), bot: !!p.bot, rank: p.rank, score: p.score };
    });
    room.addResult({ id: String(r.id || game + '-' + Date.now()), game, mode: r.mode || '', at: Date.now(), players });
  }
  let lbOpen = false, lbGame = 'all', lbOnly = false, lbBots = true;
  const GNAME = { all: 'Tous les jeux', david: 'DavidSimulator', drift: 'Duo Drift', bastion: 'Bastion Clash', calcul: 'Tête de Calcul', outbreak: 'Outbreak : Secteur Zéro', filrouge: 'Fil Rouge', kart: 'Cyber Kart GP', convoy: 'Convoy Storm' };
  const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? "à l'instant" : m < 60 ? `il y a ${m} min` : m < 1440 ? `il y a ${Math.round(m / 60)} h` : new Date(t).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }); };
  function renderBoard() {
    const ov = document.querySelector('.lbov'); if (!ov) return;
    const inRoom = room && room.mode !== 'solo' && room.players.length > 1;
    const only = lbOnly && inRoom ? room.players.map((p) => p.uid) : null;
    const rows = DDResults.table({ game: lbGame, only, bots: lbBots });
    const myUid = me.uid;
    const recent = DDResults.recent(40).filter((r) => lbGame === 'all' || r.game === lbGame).slice(0, 8);
    const scoreLabel = lbGame === 'david' ? 'Meilleur patrimoine' : lbGame === 'drift' ? 'Meilleurs points' : lbGame === 'bastion' || lbGame === 'calcul' || lbGame === 'outbreak' ? 'Meilleur score' : lbGame === 'kart' ? 'Meilleurs points' : lbGame === 'filrouge' ? 'Secondes restantes' : lbGame === 'convoy' ? 'Meilleure distance (m)' : '';
    ov.querySelector('.lbbody').innerHTML = `
      <div class="lbfilters"><div class="seg">${Object.entries(GNAME).map(([k, l]) => `<button data-g="${k}" class="${lbGame === k ? 'sel' : ''}">${l}</button>`).join('')}</div>
        ${inRoom ? `<label class="ck"><input type="checkbox" id="lbOnly" ${lbOnly ? 'checked' : ''}> Joueurs du salon</label>` : ''}
        <label class="ck"><input type="checkbox" id="lbBots" ${lbBots ? 'checked' : ''}> Bots</label></div>
      ${rows.length ? `<table class="lbt"><thead><tr><th>#</th><th>Joueur</th><th>Victoires</th><th>Parties</th><th>% victoires</th><th>Podiums</th>${scoreLabel ? `<th>${scoreLabel}</th>` : ''}</tr></thead><tbody>
        ${rows.map((x, k) => `<tr class="${x.key === myUid ? 'me' : ''}"><td>${k < 3 ? ['🥇', '🥈', '🥉'][k] : k + 1}</td><td><i class="dot" style="background:${esc(x.color)}"></i>${esc(x.name)}${x.bot ? ' <small>🤖</small>' : ''}${x.key === myUid ? ' <small>(toi)</small>' : ''}</td>
          <td><b>${x.wins}</b></td><td>${x.games}</td><td>${Math.round((x.wins / x.games) * 100)} %</td><td>${x.podiums}</td>${scoreLabel ? `<td>${lbGame === 'david' ? x.best.toLocaleString('fr-FR') + ' €' : x.best}</td>` : ''}</tr>`).join('')}</tbody></table>`
      : '<p class="lbempty">Pas encore de partie terminée. Le classement se remplit tout seul à la fin de chaque partie.</p>'}
      ${recent.length ? `<h3>Dernières parties</h3><ul class="lbrecent">${recent.map((r) => { const w = r.players.find((p) => p.rank === 1);
        return `<li><span class="g">${r.game === 'david' ? '🎲' : r.game === 'bastion' ? '🏰' : r.game === 'calcul' ? '🧮' : r.game === 'filrouge' ? '💣' : r.game === 'outbreak' ? '🧟' : r.game === 'convoy' ? '🚂' : '🏎️'}</span><span>${esc(GNAME[r.game])}${r.mode ? ' · ' + esc(r.mode) : ''}</span><b>${w ? '🏆 ' + esc(w.name) : ''}</b><small>${r.players.length} joueurs · ${ago(r.at)}</small></li>`; }).join('')}</ul>` : ''}
      <p class="nthint">Historique partagé : quand vous vous retrouvez dans un salon, les parties de chacun sont mises en commun.</p>`;
    for (const b of ov.querySelectorAll('[data-g]')) b.onclick = () => { lbGame = b.dataset.g; renderBoard(); };
    const o = ov.querySelector('#lbOnly'); if (o) o.onchange = () => { lbOnly = o.checked; renderBoard(); };
    ov.querySelector('#lbBots').onchange = (e) => { lbBots = e.target.checked; renderBoard(); };
  }
  function openBoard() {
    const ov = document.createElement('div'); ov.className = 'ntov lbov';
    ov.innerHTML = '<div class="nt card lb" role="dialog" aria-label="Classement"><button class="ntx" aria-label="Fermer">×</button><h2>🏆 Classement entre potes</h2><div class="lbbody"></div></div>';
    document.body.appendChild(ov); lbOpen = true;
    const close = () => { ov.remove(); lbOpen = false; };
    ov.querySelector('.ntx').onclick = close;
    ov.addEventListener('pointerdown', (e) => { if (e.target === ov) close(); });
    renderBoard();
  }
  for (const id of ['#btnBoard', '#btnBoardRoom']) { const b = $(id); if (b) b.onclick = openBoard; }
  if (new URLSearchParams(location.search).has('nettest')) setTimeout(openNetTest, 300);
  const busy = (b) => { for (const id of ['#btnHost', '#btnJoin', '#btnSolo']) $(id).disabled = b; };
  const profile = () => ({ name: DDRoom.cleanName(me.name), color: me.color, lvl: me.lvl, uid: me.uid });

  $('#btnHost').onclick = () => { homeErr(''); busy(true); $('#btnHost').textContent = 'Création…'; newRoom(); room.host(profile()); };
  $('#btnJoin').onclick = () => {
    const code = $('#joinCode').value.trim().toUpperCase();
    if (code.length !== 4) { homeErr('Le code fait 4 caractères.'); return; }
    homeErr(''); busy(true); $('#btnJoin').textContent = 'Connexion…'; newRoom(); room.join(code, profile());
  };
  $('#btnSolo').onclick = () => { homeErr(''); newRoom(); room.solo(profile()); };

  function goHome(msg) {
    if (room) room.leave();
    room = null; closeFrame(false); leftGame = null;
    busy(false); $('#btnHost').textContent = 'Créer un salon'; $('#btnJoin').textContent = 'Rejoindre';
    showScreen('home'); homeErr(msg || '');
    history.replaceState(null, '', location.pathname + (DDNet.LOCAL_TEST ? '?local' : ''));
  }

  /* ------------------------------------------------------------ salon */
  function newRoom() {
    if (room) room.leave();
    $('#chatLog').innerHTML = '';
    room = DDRoom.create({
      joined() { busy(false); $('#btnHost').textContent = 'Créer un salon'; $('#btnJoin').textContent = 'Rejoindre'; showScreen(frame ? 'play' : 'room'); renderRoom(); },
      update() { renderRoom(); syncFrame(); postRoster(); },
      chat(c) { appendChat(c); },
      game(from, m) { if (frame && frame.loaded) frame.el.contentWindow.postMessage({ dd: 'hub', k: 'msg', from, m }, ORIGIN); },
      error(msg) { if ($('#home').classList.contains('on')) goHome(msg); else toast(msg, 4000); },
      closed(msg) { goHome(msg); },
      results() { if (lbOpen) renderBoard(); },
      migrating(info) { toast(info.me ? "L'hôte est parti : tu deviens l'hôte…" : `L'hôte est parti : ${info.name} reprend le salon…`, 5000); },
      migrated() { toast('Salon rétabli, la partie continue', 3000); renderRoom(); syncFrame(); postRoster(); },
    });
  }
  setInterval(() => { if (room) { room.tick(performance.now()); renderPings(); } }, 2000);

  function appendChat(c) {
    const p = document.createElement('p');
    if (c.sys) { p.className = 'sys'; p.textContent = c.txt; }
    else p.innerHTML = `<b style="color:${esc(c.color || '#16181d')}">${esc(c.name)}</b> ${esc(c.txt)}`;
    const log = $('#chatLog'); log.appendChild(p); log.scrollTop = log.scrollHeight;
  }
  $('#chatForm').onsubmit = (e) => { e.preventDefault(); const v = $('#chatIn').value; if (v.trim() && room) room.sendChat(v); $('#chatIn').value = ''; };
  $('#btnLeave').onclick = () => goHome();
  $('#btnCopy').onclick = () => {
    const url = location.origin + location.pathname + '?join=' + room.code + (DDNet.LOCAL_TEST ? '&local' : '');
    (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(
      () => toast('Lien copié : envoie-le à tes potes'), () => toast('Code du salon : ' + room.code));
  };
  $('#btnRejoin').onclick = () => { leftGame = null; syncFrame(); };

  function renderPings() {
    if (!room) return;
    for (const el of document.querySelectorAll('[data-ping]')) {
      const v = room.pings[el.dataset.ping]; el.textContent = v != null ? Math.round(v) + ' ms' : '';
    }
    if (frame && frame.loaded) {
      frame.el.contentWindow.postMessage({ dd: 'hub', k: 'pings', pings: room.pings }, ORIGIN);
    }
  }

  function renderRoom() {
    if (!room) return;
    const solo = room.mode === 'solo';
    $('#codeBox').hidden = solo; $('#chatBox').hidden = solo;
    $('#code').textContent = room.code || '----';
    const host = room.isHost;
    // joueurs
    const rows = room.players.map((p) => {
      const tags = [];
      if (p.id === room.hostId) tags.push('<span class="pill">Hôte</span>');
      if (room.ready[p.id]) tags.push('<span class="pill in">En jeu</span>');
      return `<div class="pl"><span class="dot" style="background:${esc(p.color)}"></span><span class="nm">${esc(p.name)}${p.id === room.myId ? ' <small>(toi)</small>' : ''}</span>${tags.join('')}${p.id !== room.myId ? `<small data-ping="${p.id}"></small>` : ''}</div>`;
    });
    if (!solo) for (let k = room.players.length; k < DDRoom.MAX_PLAYERS; k++) rows.push('<div class="pl empty">Place libre</div>');
    $('#players').innerHTML = rows.join('');
    renderPings();
    // partie en cours que l'on a quittée
    const running = room.game && !frame;
    $('#runBanner').hidden = !running;
    if (running) $('#runText').textContent = 'Partie de ' + gameDef(room.game.id).title + ' en cours';
    // jeux
    const n = room.players.length;
    $('#games').innerHTML = GAMES.map((g) => {
      const tooMany = n > g.maxPlayers;
      const sel = (room.game ? room.game.id : pick.game) === g.id && (host || room.game);
      return `<button class="game${sel ? ' sel' : ''}${tooMany ? ' off' : ''}" data-game="${g.id}" ${host && !tooMany ? '' : 'tabindex="-1"'} aria-pressed="${sel}">
        <span class="cv">${g.cover}</span>
        <span class="tx"><span class="tg">${esc(g.tag)}</span><b>${esc(g.title)}</b><p>${esc(g.desc)}</p>
        ${tooMany ? `<span class="why">${g.maxPlayers} joueurs maximum</span>` : ''}</span></button>`;
    }).join('');
    for (const b of document.querySelectorAll('.game')) b.onclick = () => {
      if (!host || room.game) return;
      const g = gameDef(b.dataset.game); if (n > g.maxPlayers) return;
      pick.game = g.id; renderRoom();
    };
    renderLaunch();
  }

  function renderLaunch() {
    const box = $('#launchBox'), host = room.isHost;
    if (room.game) {
      box.innerHTML = host
        ? `<div class="row" style="align-items:center;justify-content:space-between"><span class="wait"><i></i>Partie de ${esc(gameDef(room.game.id).title)} en cours</span><button class="btn small ghost" id="btnStop">Arrêter pour tout le monde</button></div>`
        : `<span class="wait"><i></i>Partie de ${esc(gameDef(room.game.id).title)} en cours</span>`;
      const st = $('#btnStop'); if (st) st.onclick = () => room.setGame(null);
      return;
    }
    if (!host) { box.innerHTML = '<span class="wait"><i></i>L\'hôte choisit le jeu…</span>'; return; }
    const g = gameDef(pick.game), set = pick.settings[g.id], n = room.players.length;
    const segs = (g.settings || []).map((s) => {
      if (g.id === 'calcul' && set.mode === 'chartier' && s.key === 'theme') return '';
      // réglages propres à un mode (ou masqués dans un mode)
      if ((s.onlyMode && set.mode !== s.onlyMode) || (s.notMode && set.mode === s.notMode)) return '';
      if (g.id === 'david' && set.teams === '2v2' && s.key === 'bots') return `<div class="setitem"><div class="lbl">Bots</div><div class="sethint">${n < 4 ? `${4 - n} bot${4 - n > 1 ? 's' : ''} complète${4 - n > 1 ? 'nt' : ''} les équipes` : 'Équipes complètes'}</div></div>`;
      const opts = s.options.filter(([v]) => s.key !== 'bots' || n + Number(v) <= (g.maxWithBots || g.maxPlayers));
      return `${s.group ? `<div class="setgroup">${esc(s.group)}</div>` : ''}<div class="setitem"><div class="lbl">${esc(s.label)}</div><div class="seg" role="group" aria-label="${esc(s.label)}">${opts.map(([v, l]) =>
        `<button data-k="${s.key}" data-v="${v}" class="${String(set[s.key]) === String(v) ? 'sel' : ''}">${esc(l)}</button>`).join('')}</div></div>`;
    }).join('');
    const max = g.id === 'david' && set.teams === '2v2' ? 4 : g.maxPlayers;
    const ok = n <= max;
    box.innerHTML = `<h2>${esc(g.title)}</h2>${segs ? `<div class="setrow">${segs}</div>` : ''}
      ${ok ? '' : `<p class="sethint">Ce mode se joue à ${max} au plus.</p>`}
      <button class="btn big block ${g.id === 'david' ? 'blue' : ''}" id="btnLaunch" ${ok ? '' : 'disabled'}>Lancer ${esc(g.title)}</button>`;
    for (const b of box.querySelectorAll('.seg button')) b.onclick = () => {
      const v = isNaN(Number(b.dataset.v)) ? b.dataset.v : Number(b.dataset.v);
      set[b.dataset.k] = v; DDProfile.set('hub_set_' + g.id + '_' + b.dataset.k, v); renderLaunch();
    };
    $('#btnLaunch').onclick = () => { leftGame = null; room.setGame(g.id, { ...set }); };
  }

  /* ------------------------------------------------------------ jeu dans l'iframe */
  function syncFrame() {
    if (!room) return;
    const g = room.game;
    if (!g) { if (frame) closeFrame(true); leftGame = null; return; }
    if (frame && frame.n !== g.n) closeFrame(false);
    if (!frame && leftGame !== g.n) openFrame(g);
  }

  function openFrame(g) {
    const def = gameDef(g.id);
    DDProfile.save(me);
    const role = room.mode === 'solo' ? 'solo' : room.isHost ? 'host' : 'guest';
    const q = new URLSearchParams({ hub: '1', role, game: g.id });
    if (room.code) q.set('code', room.code);
    const pass = new URLSearchParams(location.search);
    for (const k of ['debug', 'ws']) if (pass.has(k)) q.set(k, pass.get(k));
    let src = def.url + '?' + q.toString() + (DDNet.LOCAL_TEST ? '&local' : '');
    const el = document.createElement('iframe');
    el.title = def.title; el.src = src; el.allow = 'autoplay; fullscreen; gamepad';
    $('#play').innerHTML = ''; $('#play').appendChild(el);
    frame = { game: g.id, n: g.n, el, loaded: false };
    el.addEventListener('load', () => { try { el.contentWindow.focus(); } catch (e) {} });
    showScreen('play');
    renderRoom();
  }

  function closeFrame(toRoom) {
    if (!frame) return;
    frame.el.remove(); frame = null; $('#play').innerHTML = '';
    if (room) room.setReady(null);
    if (toRoom && room) { showScreen('room'); renderRoom(); }
  }

  function postRoster() {
    if (!frame || !frame.loaded || !room) return;
    frame.el.contentWindow.postMessage({ dd: 'hub', k: 'roster', players: room.players.map(({ cid, ...p }) => p), ready: room.ready, pings: room.pings, hostId: room.hostId,
      role: room.mode === 'solo' ? 'solo' : room.isHost ? 'host' : 'guest', code: room.code }, ORIGIN);
  }

  window.addEventListener('message', (e) => {
    if (!frame || e.source !== frame.el.contentWindow) return;
    const d = e.data; if (!d || d.dd !== 'hub' || !room) return;
    switch (d.k) {
      case 'hello':
        frame.loaded = true;
        frame.el.contentWindow.postMessage({ dd: 'hub', k: 'init', info: {
          role: room.mode === 'solo' ? 'solo' : room.isHost ? 'host' : 'guest',
          myId: room.myId, hostId: room.hostId, code: room.code, game: frame.game,
          settings: room.game ? room.game.settings : {},
          players: room.players.map(({ cid, ...p }) => p), ready: room.ready, pings: room.pings,
        } }, ORIGIN);
        break;
      case 'ready': room.setReady(frame.game); break;
      case 'send': room.sendGame(d.to, d.m); break;
      case 'result': recordResult(frame.game, d.r); break;
      case 'exit':
        if (room.isHost) room.setGame(null);
        else { leftGame = frame.n; closeFrame(true); }
        break;
    }
  });

  addEventListener('pagehide', () => { try { if (room) room.leave(); } catch (e) {} });
  if (joinParam) $('#name').focus();
})();
