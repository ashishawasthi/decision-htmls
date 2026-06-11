/* Agentic System Designer v2 - state, events, and the single render pipeline.
   Dataflow is strictly one way:
     preset -> state.inputs -> derive() -> arch -> metrics/cost/diagram render.
   state.overrides holds only PINNED decisions (sparse; {} = everything Auto).
   No code path mutates inputs or overrides except a direct user edit, a preset
   application, and the permalink decode; reverting an edit therefore reverts
   every output. */
(function (NS) {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const state = {
    purpose: 'assistant',
    preset: 'expert_copilot',
    custom: false,
    inputs: {},
    overrides: {},
  };

  /* ---- preset application: clone inputs, clear pins. Nothing else. ---- */
  function applyPreset(purpose, preset) {
    if (!NS.presets.PRESETS[purpose][preset]) preset = Object.keys(NS.presets.PRESETS[purpose])[0]; /* stale permalink preset key */
    state.purpose = purpose;
    state.preset = preset;
    state.custom = false;
    state.inputs = JSON.parse(JSON.stringify(NS.presets.PRESETS[purpose][preset].inputs));
    state.overrides = {};
  }

  /* ---- controls <-> state ---- */
  function readInputs() {
    $$('section.config [data-bind]').forEach(el => {
      const k = el.dataset.bind;
      if (el.type === 'checkbox') return;
      if (el.type === 'number' || el.type === 'range') state.inputs[k] = el.value === '' ? 0 : +el.value;
      else state.inputs[k] = el.value;
    });
    state.inputs.dataSources = $$('#dataSources input:checked').map(c => c.value);
    state.inputs.languages = $$('#languages input:checked').map(c => c.value);
  }
  function syncInputs() {
    $$('section.config [data-bind]').forEach(el => {
      if (el.type === 'checkbox') return;
      const v = state.inputs[el.dataset.bind];
      if (v != null && document.activeElement !== el) el.value = v;
    });
    $$('#dataSources input').forEach(c => c.checked = state.inputs.dataSources.includes(c.value));
    $$('#languages input').forEach(c => c.checked = (state.inputs.languages || []).includes(c.value));
    $$('[data-out]').forEach(o => { const v = state.inputs[o.dataset.out]; o.textContent = v != null ? v : ''; });
    $('#purpose').value = state.purpose;
    /* input-row visibility, from inputs alone */
    const hasIndexed = state.inputs.dataSources.some(s => NS.catalog.INDEXED_SRC.includes(s));
    const staleable = state.inputs.dataSources.some(s => ['stream', 'bigquery', 'onprem', 'doc_corpus', 'website'].includes(s));
    const vis = { latencySlo: state.purpose === 'assistant', corpus: hasIndexed, freshness: staleable, languages: state.purpose === 'assistant' };
    $$('section.config .ctl[data-vis]').forEach(el => el.classList.toggle('hidden', vis[el.dataset.vis] === false));
    $('#actorLabel').textContent = state.purpose === 'automation' ? 'engineers' : 'seats';
    NS.render.renderChips(state);
  }

  /* ---- mermaid (CDN + graceful fallback) ---- */
  let mermaid = null, mermaidOK = false, renderSeq = 0, diagSrc = '';
  const isLightTheme = () => document.documentElement.getAttribute('data-theme') === 'light';
  function applyDiagramTheme() {
    if (!mermaidOK) return;
    mermaid.initialize({ startOnLoad: false, securityLevel: 'loose', theme: isLightTheme() ? 'default' : 'dark', flowchart: { htmlLabels: true, curve: 'basis' } });
  }
  async function loadMermaid() {
    try {
      const mod = await import('https://cdn.jsdelivr.net/npm/mermaid@latest/dist/mermaid.esm.min.mjs');
      mermaid = mod.default;
      mermaidOK = true;
      applyDiagramTheme();
      renderDiagram(lastArch);
    } catch (e) { console.warn('Mermaid CDN unavailable - using source fallback', e); }
  }
  async function renderDiagram(arch) {
    if (!arch) return;
    const dir = window.matchMedia('(max-width:880px)').matches ? 'TD' : 'LR';
    diagSrc = NS.diagram.buildDiagram(arch, { dir, theme: isLightTheme() ? 'light' : 'dark' });
    const host = $('#diagram');
    if (!mermaidOK) { host.innerHTML = '<div class="empty">Mermaid offline - diagram source:</div><pre>' + diagSrc.replace(/</g, '&lt;') + '</pre>'; return; }
    const id = 'd' + (++renderSeq);
    try {
      const { svg } = await mermaid.render(id, diagSrc);
      host.innerHTML = svg;
      NS.render.bindTooltips(host, arch);
    } catch (e) {
      host.innerHTML = '<pre>' + diagSrc.replace(/</g, '&lt;') + '</pre>';
      console.warn('mermaid render', e);
    }
  }

  /* ---- the single render pipeline ---- */
  let lastArch = null;
  function render() {
    const { decisions, arch, lint } = NS.derive(state.purpose, state.inputs, state.overrides);
    const m = NS.metrics.compute(arch, state.inputs);
    const issues = lint.concat(NS.metrics.lint(arch, m, state.inputs));
    const cs = NS.metrics.costSummary(arch, m, state.inputs);
    lastArch = arch;
    syncInputs();
    NS.render.updateDecisions(decisions, state.inputs, state.purpose, issues);
    NS.render.updateInputMarks(issues);
    $('#issueCount').textContent = issues.length ? `(${issues.length})` : '';
    $('#issues').innerHTML = NS.render.issuesHtml(issues);
    $('#metrics').innerHTML = NS.render.metricCards(m, arch);
    $('#cost').innerHTML = NS.render.costPanelHtml(m, cs, arch, state.inputs);
    const depTag = arch.models.selfHostAll ? 'self-host' : (arch.models.selfHostAny ? 'API + self-host' : 'managed API');
    $('#costHead').textContent = `(${depTag}) · all values $ / month`;
    $('#bom').innerHTML = NS.render.bomHtml(NS.metrics.components(arch, state.inputs));
    renderDiagram(arch);
    schedulePermalink();
  }

  /* ---- permalink: base64 JSON {v:2, p, pr, c, i, o} in the hash ---- */
  let plTimer = null;
  function encodeState(snap) {
    const s = snap || { v: 2, p: state.purpose, pr: state.preset, c: state.custom, i: state.inputs, o: state.overrides };
    return btoa(unescape(encodeURIComponent(JSON.stringify(s))));
  }
  function decodeState(h) {
    try {
      const d = JSON.parse(decodeURIComponent(escape(atob(h))));
      if (d && d.v === 2 && d.p && d.i && typeof d.o === 'object') {
        d.i = Object.assign({}, NS.presets.DEFAULT_INPUTS, d.i);
        return d;
      }
    } catch (e) { }
    return null;
  }
  function schedulePermalink() {
    clearTimeout(plTimer);
    plTimer = setTimeout(() => { try { location.replace('#' + encodeState()); } catch (e) { } }, 120);
  }
  function currentPermalink() {
    clearTimeout(plTimer);
    const base = location.href.split('#')[0];
    const h = '#' + encodeState();
    try { location.replace(h); } catch (e) { }
    return base + h;
  }

  /* ---- events ---- */
  function wire() {
    $('#purpose').addEventListener('change', e => {
      const pur = e.target.value;
      applyPreset(pur, Object.keys(NS.presets.PRESETS[pur])[0]);
      NS.render.applyInputHelp(pur);
      render();
    });
    $('#presetChips').addEventListener('click', e => {
      const c = e.target.closest('.chip');
      if (c && c.dataset.preset) { applyPreset(state.purpose, c.dataset.preset); render(); }
    });
    $('#resetBtn').addEventListener('click', () => { applyPreset(state.purpose, state.preset); render(); });
    /* left-panel inputs: read, mark custom, full re-render. Nothing else. */
    const onInput = () => { readInputs(); if (state.preset) state.custom = true; render(); };
    $$('section.config [data-bind], #dataSources input, #languages input').forEach(el => {
      el.addEventListener(el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input', onInput);
    });
    /* decision pins: '' = Auto (delete the pin), anything else pins the decoded value */
    $('#decisions').addEventListener('change', e => {
      const sel = e.target.closest('select[data-dec-key]');
      if (!sel) return;
      const key = sel.dataset.decKey;
      const reg = NS.presets.DECISIONS.find(d => d.key === key);
      if (sel.value === '') delete state.overrides[key];
      else state.overrides[key] = NS.render.decodeValue(reg, sel.value);
      if (state.preset) state.custom = true;
      render();
    });
    $('#copyMermaid').addEventListener('click', () => {
      if (navigator.clipboard) navigator.clipboard.writeText(diagSrc);
      const btn = $('#copyMermaid'); const orig = btn.innerHTML;
      btn.textContent = '✓'; setTimeout(() => btn.innerHTML = orig, 1200);
    });
    $('#permalinkBtn').addEventListener('click', () => {
      if (navigator.clipboard) navigator.clipboard.writeText(currentPermalink());
      const s = $('#permalinkBtn span'); s.textContent = 'Copied'; setTimeout(() => s.textContent = 'Permalink', 1200);
    });
    window.matchMedia('(max-width:880px)').addEventListener('change', () => renderDiagram(lastArch));
    $('#themeBtn').addEventListener('click', () => setTheme(isLightTheme() ? 'dark' : 'light', true));
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', e => {
      if (!localStorage.getItem('theme')) setTheme(e.matches ? 'light' : 'dark', false);
    });
  }
  function setTheme(theme, persist) {
    document.documentElement.setAttribute('data-theme', theme);
    if (persist) localStorage.setItem('theme', theme);
    applyDiagramTheme();
    if (mermaidOK) renderDiagram(lastArch);
  }

  /* ---- init ---- */
  function init() {
    NS.render.buildDecisionsPanel($('#decisions'));
    const decoded = location.hash.length > 1 ? decodeState(location.hash.slice(1)) : null;
    if (decoded) {
      state.purpose = decoded.p;
      state.preset = decoded.pr;
      state.custom = !!decoded.c;
      state.inputs = decoded.i;
      state.overrides = decoded.o || {};
    } else {
      applyPreset('assistant', 'expert_copilot');
    }
    wire();
    NS.render.applyInputHelp(state.purpose);
    render();
    loadMermaid();
    if (new URLSearchParams(location.search).has('test')) NS.selfTest.renderBar();
  }

  NS.app = { state, applyPreset, render, encodeState, decodeState };
  if (typeof window !== 'undefined' && typeof document !== 'undefined' && document.getElementById('decisions')) {
    init();
    window.__designer2 = NS.app;
  }
})(typeof window !== 'undefined' ? (window.ASD2 = window.ASD2 || {}) : (globalThis.ASD2 = globalThis.ASD2 || {}));
