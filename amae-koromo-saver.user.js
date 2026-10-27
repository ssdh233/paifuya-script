// ==UserScript==
// @name         amae-koromo records saver
// @description  Collects player_records loaded while scrolling, keeps them across visits, and shows the index.js analysis table
// @match        https://amae-koromo.sapk.ch/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  // ---------- collecting ----------
  // Records are kept per "<accountId>_<mode>" in localStorage, so games from earlier visits are merged automatically.
  const STORE = "koromo-records:";
  const sets = new Map(); // key -> Map(uuid -> game)
  let current = null; // { key, id }

  const setFor = (key) => {
    if (!sets.has(key)) {
      const m = new Map();
      try {
        for (const g of JSON.parse(localStorage.getItem(STORE + key) ?? "[]")) m.set(g.uuid, g);
      } catch {}
      sets.set(key, m);
    }
    return sets.get(key);
  };
  const addGames = (key, games) => {
    const m = setFor(key);
    for (const g of games) m.set(g.uuid ?? g._id, g);
    try {
      localStorage.setItem(STORE + key, JSON.stringify([...m.values()]));
    } catch {}
    update();
  };

  // The site calls window.fetch for every request, so wrapping it sees each page of records as it arrives.
  const origFetch = window.fetch;
  window.fetch = async (...args) => {
    const res = await origFetch(...args);
    const url = String(args[0]?.url ?? args[0]);
    const m = url.match(/\/player_records\/(\d+)\/.*[?&]mode=([\d.]+)/);
    if (m && res.ok) {
      res.clone().json().then((games) => {
        current = { key: `${m[1]}_${m[2]}`, id: Number(m[1]) };
        addGames(current.key, games);
      }).catch(() => {});
    }
    return res;
  };

  // ---------- analysis (same as index.js) ----------
  const LEVEL_MAX = { 10101: 20, 10102: 80, 10103: 200, 10201: 600, 10202: 800, 10203: 1000, 10301: 1200, 10302: 1400, 10303: 2000, 10401: 2800, 10402: 3200, 10403: 3600, 10501: 4000, 10502: 6000, 10503: 9000 };
  const FOURTH = { 10401: -180, 10402: -195, 10403: -210, 10501: -225, 10502: -240, 10503: -255 };
  const levelName = (id) => ["初心", "雀士", "雀傑", "雀豪", "雀聖", "魂天"][Math.floor(id / 100) % 100 - 1] + (id % 100);

  const analyze = (records, ACCOUNT, CHUNK, AS) => {
    const games = records
      .map((g) => {
        const players = [...(g.players ?? g.playerData)].sort((a, b) => b.score - a.score);
        const rank = players.findIndex((p) => p.accountId === ACCOUNT);
        if (rank < 0) return null;
        return { start: g.startTime, rank, pt: players[rank].gradingScore, lv: players[rank].level };
      })
      .filter(Boolean)
      .sort((a, b) => a.start - b.start);
    if (!games.length) return [];

    // A game's level is the level before it. A level change resets pt to half of the new level's max;
    // pt is unknown until the first change since the starting pt isn't in the data.
    const state = [];
    let levelPt = null;
    games.forEach((g, i) => {
      if (i > 0 && g.lv !== games[i - 1].lv) {
        levelPt = LEVEL_MAX[g.lv] ? LEVEL_MAX[g.lv] / 2 : null;
        state[i - 1] = { lv: g.lv, pt: levelPt };
      }
      if (levelPt !== null) levelPt += g.pt;
      state[i] = { lv: g.lv, pt: levelPt };
    });
    // AS: recompute every game's pt as if played at that level (only the 4th place pt depends on the level).
    if (AS) {
      for (const g of games) {
        if (g.rank === 3) {
          if (FOURTH[g.lv] === undefined || FOURTH[AS] === undefined) throw new Error(`unknown 4th place pt for level ${g.lv} or ${AS}`);
          g.pt += FOURTH[AS] - FOURTH[g.lv];
        }
        g.lv = AS;
      }
    }
    const levelCols = (i) => [levelName(state[i].lv), state[i].pt ?? "-"];

    const total = [0, 0, 0, 0];
    games.forEach((g) => total[g.rank]++);
    const p = total.map((c) => c / games.length);

    // Null model: rank follows the overall rank rates, pt follows the observed pts for that (rank, level),
    // pooled over levels when fewer than 5 samples.
    const byRank = [[], [], [], []];
    const byRankLevel = new Map();
    games.forEach((g) => {
      byRank[g.rank].push(g.pt);
      const k = `${g.rank}:${g.lv}`;
      if (!byRankLevel.has(k)) byRankLevel.set(k, []);
      byRankLevel.get(k).push(g.pt);
    });
    const nullCache = new Map();
    const nullFor = (lv) => {
      if (!nullCache.has(lv)) {
        const m = new Map();
        for (let r = 0; r < 4; r++) {
          let smp = byRankLevel.get(`${r}:${lv}`) ?? [];
          if (smp.length < 5) smp = byRank[r];
          for (const v of smp) m.set(v, (m.get(v) ?? 0) + p[r] / smp.length);
        }
        const dist = [...m];
        const mu = dist.reduce((s, [v, q]) => s + v * q, 0);
        const variance = dist.reduce((s, [v, q]) => s + q * (v - mu) ** 2, 0);
        nullCache.set(lv, { dist, mu, variance, min: Math.min(...m.keys()), max: Math.max(...m.keys()) });
      }
      return nullCache.get(lv);
    };

    // z (positive = lucky) and a signed mid-p percentile within the lucky / unlucky side.
    const luck = (part) => {
      const obs = part.reduce((s, g) => s + g.pt, 0);
      let d = new Float64Array([1]);
      let offset = 0;
      let mu = 0;
      let variance = 0;
      for (const g of part) {
        const m = nullFor(g.lv);
        const next = new Float64Array(d.length + m.max - m.min);
        for (let j = 0; j < d.length; j++) {
          if (d[j] < 1e-18) continue;
          for (const [v, q] of m.dist) next[j + v - m.min] += d[j] * q;
        }
        d = next;
        offset += m.min;
        mu += m.mu;
        variance += m.variance;
      }
      const idx = obs - offset;
      let below = 0;
      for (let j = 0; j < idx; j++) below += d[j];
      const L = below + d[idx] / 2;
      const z = (obs - mu) / Math.sqrt(variance);
      return [z.toFixed(2), (z >= 0 ? "+" : "-") + (Math.abs(2 * L - 1) * 100).toFixed(1) + "%"];
    };
    // Stable level: where this block would average 0 pt per game (雀聖1 = 聖1.00, -15 per level step).
    const stable = (part) => {
      let base = 0;
      let fourths = 0;
      for (const g of part) {
        base += g.rank === 3 ? g.pt - FOURTH[g.lv] : g.pt;
        if (g.rank === 3) fourths++;
      }
      if (!fourths) return ["-"];
      const penalty = -base / fourths;
      return ["聖" + ((FOURTH[10501] - penalty) / 15 + 1).toFixed(2)];
    };

    const rows = [["", "1st", "2nd", "3rd", "4th", "平均順位", "pt", "z", "percentile", "安定段位", "段位", "段位pt"]];
    let cum = 0;
    for (let i = 0; i < games.length; i += CHUNK) {
      const part = games.slice(i, i + CHUNK);
      const cnt = [0, 0, 0, 0];
      let pt = 0;
      for (const g of part) {
        cnt[g.rank]++;
        pt += g.pt;
      }
      cum += pt;
      const avg = part.reduce((s, g) => s + g.rank + 1, 0) / part.length;
      rows.push([`${i + 1}-${i + part.length}`, ...cnt, avg.toFixed(2), pt, ...luck(part), ...stable(part), ...levelCols(i + part.length - 1)]);
    }
    rows.push(["total", ...total, (games.reduce((s, g) => s + g.rank + 1, 0) / games.length).toFixed(2), cum, "", "", ...stable(games), "", ""]);
    return rows;
  };

  // ---------- UI ----------
  const css = (el, s) => ((el.style.cssText = s), el);
  const btnStyle = "padding:10px 14px;font-size:14px;border:0;border-radius:6px;background:#1677ff;color:#fff;cursor:pointer;box-shadow:0 2px 8px #0004";
  const bar = css(document.createElement("div"), "position:fixed;right:16px;bottom:16px;z-index:99999;display:flex;gap:8px");
  const mkBtn = (label, onclick) => {
    const b = css(document.createElement("button"), btnStyle);
    b.textContent = label;
    b.onclick = onclick;
    bar.appendChild(b);
    return b;
  };
  const records = () => (current ? [...setFor(current.key).values()] : []);

  const analyzeBtn = mkBtn("分析", () => showPanel());
  const saveBtn = mkBtn("", () => {
    if (!current) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(records().sort((a, b) => b.startTime - a.startTime))], { type: "application/json" }));
    a.download = `${current.key}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  // Merge previously saved JSON files (e.g. the ones in Downloads) into the current player's records.
  const fileInput = Object.assign(document.createElement("input"), { type: "file", accept: ".json", multiple: true });
  fileInput.onchange = async () => {
    if (!current) return alert("先にプレイヤーページを開いてください");
    for (const f of fileInput.files) {
      const raw = JSON.parse(await f.text());
      addGames(current.key, Array.isArray(raw) ? raw : raw.records ?? raw.data);
    }
    fileInput.value = "";
    if (panel.isConnected) render();
  };
  mkBtn("JSON読込", () => fileInput.click());

  function update() {
    saveBtn.textContent = `JSON保存 (${records().length}件)`;
    analyzeBtn.disabled = !current;
  }

  const panel = css(document.createElement("div"), "position:fixed;inset:5vh 5vw;z-index:100000;background:#fff;color:#222;border-radius:8px;box-shadow:0 4px 24px #0006;padding:16px;overflow:auto;font:13px/1.5 sans-serif");
  const controls = css(document.createElement("div"), "display:flex;gap:12px;align-items:center;margin-bottom:12px;flex-wrap:wrap");
  const sizeIn = document.createElement("select");
  sizeIn.innerHTML = `<option value="50">50戦</option><option value="100">100戦</option>`;
  const asSel = document.createElement("select");
  asSel.innerHTML = `<option value="">実際の段位</option>` + Object.keys(FOURTH).map((k) => `<option value="${k}">${levelName(+k)}</option>`).join("");
  const info = document.createElement("span");
  const copyBtn = document.createElement("button");
  copyBtn.textContent = "TSVコピー";
  const closeBtn = document.createElement("button");
  closeBtn.textContent = "閉じる";
  closeBtn.onclick = () => panel.remove();
  const label = (t, el) => {
    const l = document.createElement("label");
    l.append(t + " ", el);
    return l;
  };
  controls.append(label("区間", sizeIn), label("pt計算", asSel), copyBtn, closeBtn, info);
  const table = css(document.createElement("table"), "border-collapse:collapse;white-space:nowrap");
  panel.append(controls, table);
  sizeIn.onchange = asSel.onchange = () => render();

  let lastRows = [];
  copyBtn.onclick = () => navigator.clipboard.writeText(lastRows.map((r) => r.join("\t")).join("\n"));

  function render() {
    try {
      lastRows = analyze(records(), current.id, Number(sizeIn.value), asSel.value && Number(asSel.value));
    } catch (e) {
      info.textContent = e.message;
      return;
    }
    info.textContent = `${current.key} / ${records().length}件`;
    table.innerHTML = "";
    lastRows.forEach((r, i) => {
      const tr = table.insertRow();
      if (i === 0 || i === lastRows.length - 1) tr.style.fontWeight = "bold";
      for (const c of r) {
        const td = css(tr.insertCell(), "border:1px solid #ddd;padding:3px 8px;text-align:right");
        td.textContent = c;
        if (/^-\d|^-[\d.]+%$/.test(String(c)) && i > 0) td.style.color = "#c00";
      }
    });
  }
  const showPanel = () => {
    if (!current) return;
    document.body.appendChild(panel);
    render();
  };

  update();
  const mount = () => document.body.appendChild(bar);
  document.body ? mount() : document.addEventListener("DOMContentLoaded", mount);
})();
