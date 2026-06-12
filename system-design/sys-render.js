/* Agentic System Designer v2 - DOM rendering.
   Builds the derived-decisions panel once from the registry and then updates it
   in place (option-0 text, selection, pin marks, visibility), so focus is never
   destroyed mid-edit. All panel HTML is a pure function of (arch, metrics,
   costSummary, issues); state handling lives in asd2-app.js. */
(function (NS) {
  'use strict';
  const C = () => NS.catalog;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const INFO_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>';
  const infoIcon = (doc, name) => `<a class="info-i" href="${doc}" target="_blank" rel="noopener" title="About ${name} (opens in new tab)" aria-label="About ${name}">${INFO_SVG}</a>`;

  /* ---- decision option helpers ---- */
  function optionList(reg) {
    if (reg.type === 'bool') return [{ v: 'true', label: 'On' }, { v: 'false', label: 'Off' }];
    if (reg.type === 'steps') {
      const out = [];
      for (let v = reg.min; v <= reg.max; v += reg.step) out.push({ v: String(v), label: String(v) });
      return out;
    }
    const opts = reg.options === 'MODELS' ? C().MODELS.map(m => ({ v: m.id, label: m.name })) : reg.options;
    return opts.map(o => ({ v: String(o.v), label: o.label }));
  }
  function valueLabel(reg, value) {
    if (reg.type === 'bool') return value ? 'on' : 'off';
    const hit = optionList(reg).find(o => o.v === String(value));
    return hit ? hit.label : String(value);
  }
  function encodeValue(value) { return String(value); }
  function decodeValue(reg, raw) {
    if (reg.type === 'bool') return raw === 'true';
    if (reg.type === 'steps') return +raw;
    return raw;
  }

  /* Build the decisions panel once: one fieldset per group, one .ctl.dec row per decision. */
  function buildDecisionsPanel(container) {
    const groups = [];
    const byGroup = new Map();
    for (const reg of NS.presets.DECISIONS) {
      if (!byGroup.has(reg.group)) { byGroup.set(reg.group, []); groups.push(reg.group); }
      byGroup.get(reg.group).push(reg);
    }
    container.innerHTML = groups.map(g => {
      const rows = byGroup.get(g).map(reg => {
        const opts = optionList(reg).map(o => `<option value="${o.v}">${o.label}</option>`).join('');
        return `<div class="ctl dec" data-dec="${reg.key}"><label title="${(reg.help || '').replace(/"/g, '&quot;')}">${reg.label}</label>` +
          `<select data-dec-key="${reg.key}"><option value=""></option>${opts}</select>` +
          `<span class="why"></span></div>`;
      }).join('');
      return `<fieldset data-dec-group="${g}"><legend>${g}</legend>${rows}</fieldset>`;
    }).join('');
  }

  /* Update the decisions panel in place from the resolved decisions. */
  function updateDecisions(decisions, inputs, purpose, issues) {
    const dvals = Object.fromEntries(Object.entries(decisions).map(([k, v]) => [k, v.value]));
    let pins = 0;
    for (const reg of NS.presets.DECISIONS) {
      const row = $(`.dec[data-dec="${reg.key}"]`);
      if (!row) continue;
      const dec = decisions[reg.key];
      const visible = reg.vis ? !!reg.vis(dvals, inputs, purpose) : true;
      row.classList.toggle('hidden', !visible);
      const sel = row.querySelector('select');
      const auto = sel.options[0];
      auto.textContent = `Auto: ${valueLabel(reg, dec.auto)}`;
      auto.title = dec.why || '';
      if (document.activeElement !== sel) sel.value = dec.pinned ? encodeValue(dec.value) : '';
      row.classList.toggle('pinned', dec.pinned);
      sel.classList.toggle('auto', !dec.pinned);
      row.querySelector('.why').textContent = dec.pinned ? `pinned (Auto would pick: ${valueLabel(reg, dec.auto)})` : '';
      if (dec.pinned) pins++;
      /* warn mark when a lint names this decision */
      const hasIssue = (issues || []).some(x => x.src === reg.key);
      let wm = row.querySelector('.warnmark');
      if (hasIssue && !wm) { wm = document.createElement('span'); wm.className = 'warnmark'; wm.textContent = '⚠'; wm.title = 'See issues & levers'; row.querySelector('label').appendChild(wm); }
      if (!hasIssue && wm) wm.remove();
    }
    const pc = $('#pinCount');
    if (pc) pc.textContent = pins ? `(${pins} pinned)` : '(all auto)';
    /* hide a group whose rows are all hidden */
    $$('#decisions fieldset').forEach(fs => {
      const anyVisible = $$('.dec', fs).some(r => !r.classList.contains('hidden'));
      fs.style.display = anyVisible ? '' : 'none';
    });
  }

  /* Input-row warn marks (lints whose src is an input name). */
  function updateInputMarks(issues) {
    $$('section.config [data-bind]').forEach(el => {
      const ctl = el.closest('.ctl');
      if (!ctl || ctl.classList.contains('dec')) return;
      const key = el.dataset.bind;
      const hasIssue = (issues || []).some(x => x.src === key);
      let wm = ctl.querySelector('.warnmark');
      if (hasIssue && !wm) { wm = document.createElement('span'); wm.className = 'warnmark'; wm.textContent = '⚠'; wm.title = 'See issues & levers'; const lab = ctl.querySelector('label'); if (lab) lab.appendChild(wm); }
      if (!hasIssue && wm) wm.remove();
    });
  }

  /* Dim the data-source checkboxes the derived design ignores (arch.retrieval
     .ignoredSources): the box stays checked, but the label is struck through and
     carries a ⚠ so the input matches the diagram, which never draws the source.
     The input is never unchecked here - derivation does not mutate inputs, so
     raising the SLO or changing the path brings the source straight back. */
  function updateDataSourceMarks(arch) {
    const ignored = new Set((arch && arch.retrieval && arch.retrieval.ignoredSources) || []);
    $$('#dataSources label').forEach(lab => {
      const cb = lab.querySelector('input'); if (!cb) return;
      const off = cb.checked && ignored.has(cb.value);
      lab.classList.toggle('inactive', off);
      let wm = lab.querySelector('.warnmark');
      if (off && !wm) {
        wm = document.createElement('span'); wm.className = 'warnmark'; wm.textContent = '⚠';
        wm.title = 'Selected but unused on this design path: the derivation ignores it, so it never appears in the architecture, cost, or BoM. See Issues & levers - raise the SLO or change the path to use it. Left checked so it returns when the design can use it.';
        lab.appendChild(wm);
      }
      if (!off && wm) wm.remove();
    });
  }

  function issuesHtml(issues) {
    if (!issues.length) return '<div class="empty">No conflicts - clean config.</div>';
    const order = [], groups = {};
    for (const x of issues) { if (!groups[x.sev]) { groups[x.sev] = []; order.push(x.sev); } groups[x.sev].push(x); }
    return order.map(sev => `<div class="igroup"><span class="sev ${sev}">${sev}</span><ul class="ilist">${groups[sev].map(x => `<li>${x.msg}${x.save ? ` <span class="save">${x.save}</span>` : ''}</li>`).join('')}</ul></div>`).join('');
  }

  function metricCards(m, arch) {
    const fmt = C().fmt;
    const card = (k, v, t) => `<div class="metric" title="${(t || '').replace(/"/g, '&quot;')}"><div class="k">${k}</div><div class="v">${v}</div></div>`;
    const cards = [];
    cards.push(card(m.volLabel + ' avg / peak', `${fmt(m.volAvg, 2)} <small>/ ${fmt(m.volPeak, 2)}</small>`, 'actors x actions/day over the active window, x burst'));
    const fan = arch.agent.modelCallsPerReq;
    if (fan > 1) cards.push(card('Model-call QPS (peak)', `${fmt(m.volPeak * fan, 2)} <small>· x${fan} fan-out</small>`, 'user QPS x agent fan-out (agents x a damped ReAct loop); Model Armor quota and token spend size on this, not user QPS'));
    if (!arch.agent.answerOnly) cards.push(card('Tokens / day', fmt(m.tokensDay, 1), 'daily actions x (in+out)'));
    if (arch.caching.responseCacheOn) {
      const chParts = [`base ${arch.caching.cacheHitBase || 0}%`];
      if (arch.caching.autocomplete) chParts.push('autocomplete +25');
      if (arch.caching.warming) chParts.push('warming +10');
      cards.push(card('Cache hit (eff.)', (m.cacheHitEff * 100).toFixed(0) + '%', `effective response-cache hit rate = ${chParts.join(' + ')}, capped at 80%`));
    }
    if (m.indexGB > 0 && arch.retrieval.storeDrawn) cards.push(card('Vector index', fmt(m.indexGB, 1) + ' <small>GB · ' + m.shards + ' shard(s)</small>', 'chunks x dim x 4 bytes, served from a managed ScaNN store'));
    if (m.runSuccessPct != null) cards.push(card('End-to-end success', m.runSuccessPct.toFixed(0) + '% <small>at ' + Math.round(C().K.perf.stepSuccess * 100) + '%/step x ' + m.runSuccessSteps + ' expected steps' + (arch.agent.reactMaxIter > m.runSuccessSteps ? ' · guard ' + arch.agent.reactMaxIter : '') + '</small>', 'task success compounds per EXPECTED step (0.99^8 = 92%, 0.95^8 = 66%): keep the agent narrow, make each step verifiable, put deterministic checks between steps. The ReAct cap is the loop guard, set ~1.5x above expected; guard hits escalate with the trace attached'));
    if (m.gpuNodes) cards.push(card('Self-host fleet', `${m.gpuNodes} <small>x 8 ${(arch.sizing.accelerator || 'h100').toUpperCase()} · ${m.gpuUtilPct}% util</small>`, 'nodes to serve peak decode tokens/s at the chosen precision and accelerator; sized on peak QPS x output tokens'));
    cards.push(card('Latency p95', (m.latencyP95 >= 1000 ? (m.latencyP95 / 1000).toFixed(1) + 's' : Math.round(m.latencyP95) + 'ms') + (m.latencyBudget < Infinity ? ` <small${m.latencyOverBudget ? ' style="color:var(--err)"' : ''}>SLO ${m.latencyBudget / 1000}s</small>` : ''), 'critical-path sum; grounding fans out in parallel (slowest wins)'));
    if (m.latencyStartP95 != null) cards.push(card('First token p95', (m.latencyStartP95 >= 1000 ? (m.latencyStartP95 / 1000).toFixed(1) + 's' : Math.round(m.latencyStartP95) + 'ms') + (m.latencyStartBudget < Infinity ? ` <small${m.latencyStartOverBudget ? ' style="color:var(--err)"' : ''}>start SLO ${m.latencyStartBudget / 1000}s</small>` : ''), m.latencyStartIsGated ? 'validator-gated team: the Validator only scores a complete draft, so the first answer token waits for the validated draft (= full p95); pin the pattern to single agent for a streamed start' : (arch.agent.answerOnly ? 'the Agent Search answer streams from the service: first token = full p95 minus the answer-streaming time' : 'single agent streams as it generates: first token = full p95 minus the output-streaming time')));
    return cards.join('');
  }

  /* Performance & capacity panel: a latency waterfall over the p95 line items,
     the peak QPS funnel, and the concurrency ceilings. Pure function of
     (m, arch); rows reuse the expandable cost-row pattern, so the substituted
     formula behind every number sits one click away, same as the cost panel. */
  function perfPanelHtml(m, arch) {
    const cat = C(), fmt = cat.fmt;
    const esc = s => String(s == null ? '' : s).replace(/"/g, '&quot;');
    const msF = ms => ms >= 1000 ? (ms / 1000).toFixed(2) + 's' : Math.round(ms) + 'ms';
    const pc = m.perfCalc || {};
    const row = (label, val, o = {}) => {
      const cls = `cost-row${o.warn ? ' warn' : ''}`;
      const core = `<span class="cl"${o.why ? ` title="${esc(o.why)}"` : ''}>${label}${o.sub ? ` <small>${o.sub}</small>` : ''}</span><span class="cn">${val}</span>`;
      if (!o.calc && !o.why) return `<div class="${cls}">${core}</div>`;
      const detail = (o.calc ? `<div class="calc">${o.calc}</div>` : '') + (o.why ? `<div class="why">${o.why}</div>` : '');
      return `<details class="cost-line"><summary class="${cls}">${core}</summary><div class="cost-detail">${detail}</div></details>`;
    };
    const grp = t => `<div class="cost-grp">${t}</div>`;
    const unit = arch.purpose === 'automation' ? ' runs/s' : ' req/s';
    const q = v => fmt(v, 2);
    const rows = [];

    /* Latency waterfall: bars scale to the larger of the p95 and the SLO budget,
       so an under-budget design visibly leaves room. The streaming tail of the
       generation item is hatched; parallel grounding branches are dotted. */
    const scaleMax = Math.max(m.latencyP95, m.latencyBudget < Infinity ? m.latencyBudget : 0) || 1;
    const w = ms => Math.min(100, Math.max(ms > 0 ? 0.8 : 0, ms / scaleMax * 100));
    rows.push(grp('Latency p95 waterfall <small>(critical path; p95 assumes a cache miss)</small>'));
    for (const p of m.latParts) {
      const stream = p.stream && p.stream < p.ms ? p.stream : 0;
      rows.push(`<div class="lat-row" title="${esc(p.note || '')}"><span class="lat-l">${p.label}</span><span class="lat-bar"><i style="width:${w(p.ms - stream)}%"></i>${stream ? `<i class="stream" style="width:${w(stream)}%" title="output streaming: ${msF(stream)} of ${msF(p.ms)}"></i>` : ''}</span><span class="lat-ms">${msF(p.ms)}</span></div>`);
      if (p.parallel) for (const s of p.parallel) rows.push(`<div class="lat-row sub" title="parallel grounding branch - the slowest sets the stage time"><span class="lat-l">${s.label}</span><span class="lat-bar"><i class="par" style="width:${w(s.ms)}%"></i></span><span class="lat-ms">${msF(s.ms)}</span></div>`);
    }
    if (m.latencyStartP95 != null) rows.push(`<div class="lat-row tot${m.latencyStartOverBudget ? ' over' : ''}" title="${m.latencyStartIsGated ? 'the Validator only scores a complete draft, so the first answer token waits for the validated draft: start = full' : 'the answer streams: first token = full p95 minus the streaming tail'}"><span class="lat-l">First token p95${m.latencyStartIsGated ? ' <small>= full · validator-gated</small>' : ''}</span><span class="lat-bar"><i class="mark" style="width:${w(m.latencyStartP95)}%"></i></span><span class="lat-ms">${msF(m.latencyStartP95)}${m.latencyStartBudget < Infinity ? ` / ${msF(m.latencyStartBudget)} SLO` : ''}</span></div>`);
    rows.push(`<div class="lat-row tot${m.latencyOverBudget ? ' over' : ''}" title="sum of the line items above; parallel branches already collapsed to the slowest"><span class="lat-l">Full answer p95</span><span class="lat-bar"><i class="mark full" style="width:${w(m.latencyP95)}%"></i></span><span class="lat-ms">${msF(m.latencyP95)}${m.latencyBudget < Infinity ? ` / ${msF(m.latencyBudget)} SLO` : ''}</span></div>`);

    /* Peak QPS funnel: each stage sees a different load, and each names what
       is sized on it. */
    rows.push(grp(`Peak load funnel <small>(${arch.purpose === 'automation' ? 'runs' : 'requests'}/s at burst)</small>`));
    const answerOnly = !!arch.agent.answerOnly;
    rows.push(row('Client ingress', q(m.volPeak) + unit, { sub: arch.topology.privateOnly ? 'IAP / mTLS over interconnect' : (arch.gov.gateway ? 'API Gateway + Apigee' : 'direct'), calc: pc.ingress, why: 'What the request edge is sized and rate-limited on.' }));
    if (arch.caching.responseCacheOn) rows.push(row('Served from response cache', q(m.volPeak * m.cacheHitEff) + unit, { sub: Math.round(m.cacheHitEff * 100) + '% effective hit rate', calc: pc.cache, why: 'Hits return in 5-30 ms and never reach the agent, the models, or retrieval.' }));
    rows.push(row(answerOnly ? 'Agent Search answers' : 'Agent compute', q(m.qpsAgentPeak) + unit, { sub: answerOnly ? 'managed answer API, no agent' : `~${m.agentInstances} instance(s)`, calc: pc.agentQps, why: answerOnly ? 'Cache misses answered directly by Agent Search; what its query quota is sized on.' : 'Cache misses that run the full agent path; what the agent runtime autoscales on.' }));
    if (m.qpsRetrievalPeak > 0 && !answerOnly) rows.push(row('Retrieval queries', q(m.qpsRetrievalPeak) + ' q/s', { sub: arch.retrieval.ragEngine === 'vais' ? 'Agent Search' : (arch.retrieval.vectorDB === 'vertex' ? 'Vector Search' : 'AlloyDB ScaNN'), calc: arch.retrieval.selfbuilt ? pc.vvs : '', why: 'One grounding query per agent-served request.' }));
    if (m.qpsLivePeak > 0) rows.push(row('Live source queries', q(m.qpsLivePeak) + ' q/s', { sub: (arch.retrieval.liveSel || []).map(s => cat.SRC_LABEL[s] || s).join(' · '), why: 'Query-time calls to each selected live source on the hot path.' }));
    if (m.qpsWebPeak > 0) rows.push(row('Web grounding searches', q(m.qpsWebPeak) + ' q/s', { sub: 'billed per search', why: 'One live web search per agent-served request, matching the grounding cost line.' }));
    if (m.qpsModelPeak > 0) rows.push(row('Model calls', q(m.qpsModelPeak) + ' calls/s', { sub: `x${arch.agent.modelCallsPerReq} fan-out${arch.models.armorOn ? ' · screened by Model Armor' : ''}`, calc: pc.modelQps, why: 'Model rate limits (and Model Armor) size on this stream, not on user QPS.' }));
    if (m.stateOpsPeak > 0) rows.push(row('State store ops', q(m.stateOpsPeak) + ' ops/s', { sub: `${m.dbNodes} node(s)`, calc: pc.state, why: 'Session read plus turn and run-state writes; the same node count the state-store cost line bills.' }));
    if (m.linkMbpsPeak != null) rows.push(row('Interconnect VLAN load', (m.linkMbpsPeak < 10 ? m.linkMbpsPeak.toFixed(1) : String(Math.round(m.linkMbpsPeak))) + ' Mbps', { sub: `${m.linkUtilPct < 1 ? '<1' : Math.round(m.linkUtilPct)}% of the link`, calc: pc.link, why: 'Every request and response rides the private link in a hybrid design; token payloads rarely stress it.' }));

    /* Concurrency and the ceilings that bind first. */
    rows.push(grp('Concurrency &amp; ceilings'));
    rows.push(row('In-flight at peak', fmt(m.inflightPeak, 1), { sub: arch.purpose === 'automation' ? 'concurrent runs' : 'concurrent requests', calc: pc.inflight, why: "Little's law: arrival rate x time in system. Connection pools, run-state working sets, and instance counts size on this." }));
    if (m.agentInstances != null) rows.push(row('Agent instances', String(m.agentInstances), { sub: `${cat.K.perf.instConcurrency} streams/instance · floor ${cat.K.perf.instMin} for HA`, calc: pc.instances, why: 'Agentic requests hold a streamed connection open while awaiting model calls, so instances are concurrency-bound, not CPU-bound.' }));
    if (!answerOnly) rows.push(row('Token throughput at peak', `${fmt(m.tokInPeakSec, 1)} in · ${fmt(m.tokOutPeakSec, 1)} out tok/s`, { sub: fmt(m.tokPerMinPeak, 1) + ' tok/min' + (m.needsProvisionedThroughput ? ' · reserve Provisioned Throughput' : ''), warn: m.needsProvisionedThroughput, calc: pc.tok, why: 'What the model quota must sustain at peak. Dynamic shared quota does not guarantee capacity; past ~' + fmt(cat.K.perf.ptTokMinThreshold) + ' tok/min, reserve Provisioned Throughput for the steady share.' }));
    if (m.vvsNodes && arch.retrieval.storeDrawn && arch.retrieval.selfbuilt && arch.retrieval.vectorDB === 'vertex') rows.push(row('Vector serving nodes', String(m.vvsNodes), { sub: m.vvsNodesQps > m.vvsNodesSize ? 'QPS-bound' : 'size-bound', calc: pc.vvs, why: 'The wider of the index-size bound and the peak-QPS bound; the Vector Search cost line bills this same count.' }));
    if (m.gpuFleetTPS) rows.push(row('Self-host fleet capacity', fmt(m.gpuFleetTPS, 1) + ' tok/s', { sub: m.gpuHeadroomPct != null ? `+${Math.round(m.gpuHeadroomPct)}% headroom over peak` : 'routing sends it no traffic', calc: pc.gpu, why: 'Decode capacity of the GPU fleet at the configured utilisation vs the peak output tokens/s it was sized for.' }));
    return `<div class="costbox">${rows.join('')}</div>`;
  }

  function costPanelHtml(m, cs, arch, inputs) {
    const money = C().money, PRICE = C().PRICE, GP = C().GENAI_PRICE;
    const esc = s => String(s == null ? '' : s).replace(/"/g, '&quot;');
    /* A row with any of calc / why / ref renders as an expandable <details>: the
       summary is the normal cost row; the detail shows the substituted formula,
       the assumption, and the pricing link. Rows with none stay a plain div.
       Open state is browser presentation state; a re-render collapses it, which
       is correct because the expanded math belonged to the old numbers. */
    const row = (label, val, o = {}) => {
      const cls = `cost-row${o.tot ? ' tot' : ''}${o.gap ? ' gap' : ''}${o.btl ? ' btl' : ''}${o.dim ? ' dim' : ''}`;
      const core = `<span class="cl"${o.why ? ` title="${esc(o.why)}"` : ''}>${label}${o.sub ? ` <small>${o.sub}</small>` : ''}</span><span class="cn">${val}</span>`;
      if (!o.calc && !o.why && !o.ref) return `<div class="${cls}">${core}</div>`;
      const detail = (o.calc ? `<div class="calc">${o.calc}</div>` : '') +
        (o.why ? `<div class="why">${o.why}</div>` : '') +
        (o.ref ? `<a href="${o.ref}" target="_blank" rel="noopener">pricing -&gt;</a>` : '');
      return `<details class="cost-line"><summary class="${cls}">${core}</summary><div class="cost-detail">${detail}</div></details>`;
    };
    const grp = t => `<div class="cost-grp">${t}</div>`;
    const rows = [];
    const cp = m.costParts || {}, cc = m.costCalc || {};
    if (arch.agent.answerOnly) {
      rows.push(grp('GenAI · bundled'));
      rows.push(row('Model calls (yours)', money(0), { sub: 'none - the grounded answer is generated inside Agent Search', why: 'The no-agent path makes no external model call: Agent Search Enterprise bundles retrieval and answer generation in its per-query price (the Agent Search platform line below).' }));
    } else if (!arch.models.selfHostAll) {
      rows.push(grp('GenAI · managed inference'));
      rows.push(row('Input · fresh', money(cp.fresh), { calc: cc.fresh, why: GP.fresh.why, ref: GP.fresh.ref }));
      rows.push(row('Input · cached', money(cp.cached), { sub: 'billed at model cache-read rate', calc: cc.cached, why: GP.cached.why, ref: GP.cached.ref }));
      rows.push(row('Output', money(cp.output), { calc: cc.output, why: GP.output.why, ref: GP.output.ref }));
      if (cp.grounding > 0) rows.push(row('Web grounding', money(cp.grounding), { sub: 'live web search · $/1k calls', calc: cc.grounding, why: GP.grounding.why, ref: GP.grounding.ref }));
      rows.push(row('GenAI', money(m.costOpt), { tot: true, why: GP.genai.why }));
      if (m.costNaive > 0 && m.costNaive > m.costOpt) {
        const savedPct = Math.round((1 - m.costOpt / m.costNaive) * 100);
        rows.push(row('Naive baseline', money(m.costNaive), { sub: 'reasoning model, no cache/routing', dim: true, calc: cc.naive, why: GP.naive.why }));
        rows.push(row('Optimizations save', money(m.costNaive - m.costOpt) + ` (${savedPct}%)`, { sub: 'vs naive', dim: true, calc: cc.saved, why: GP.saved.why }));
      }
    }
    if (m.gpuMo) {
      rows.push(grp('GenAI · self-host on GPUs'));
      rows.push(row('GPU fleet', money(m.gpuMo), { sub: `${m.gpuNodes}x8 ${(arch.sizing.accelerator || 'h100').toUpperCase()} · ${m.gpuTierLabel} · ${m.gpuUtilPct}% util`, calc: cc.gpu, why: GP.gpu.why, ref: GP.gpu.ref }));
      rows.push(row('Inference', money(m.gpuMo), { tot: true }));
    }
    rows.push(grp('Platform &amp; infrastructure <small>(derived)</small>'));
    cs.priced.forEach(x => {
      const en = PRICE[x.name] || {};
      const tag = x.mo === 0 ? (en.note || 'within free tier') : ('est.' + (en.note ? ' · ' + en.note : ''));
      rows.push(row(x.name, money(x.mo), { sub: tag, calc: x.calc, why: en.why, ref: en.ref }));
    });
    cs.red.forEach(x => rows.push(`<div class="cost-row red"><span class="cl" title="${esc(x.why)}">${x.name} <small>${x.short} · not modeled</small></span><span class="cn">n/a</span></div>`));
    if (cs.free.length) rows.push(`<div class="cost-row"><span class="cl">Included at no charge <small>${cs.free.join(' · ')}</small></span><span class="cn">$0</span></div>`);
    rows.push(row('Platform', money(cs.platMo) + (cs.red.length ? ` <span class="cred">+${cs.red.length} unpriced</span>` : ''), { sub: cs.priced.length + ' priced', tot: true, calc: cs.calc && cs.calc.plat, why: GP.plat.why }));
    rows.push(row('Total run-rate', money(cs.totalMo), { sub: `GenAI + platform${cs.red.length ? ' · excludes unpriced' : ''}`, tot: true, calc: cs.calc && cs.calc.total, why: GP.total.why }));
    if (m.reqMo > 0) rows.push(row('Cost / 1k requests', '$' + cs.perK.toFixed(2), { sub: 'total run-rate / monthly requests', gap: true, calc: cs.calc && cs.calc.perK, why: GP.perK.why }));
    if (cs.btl && cs.btl.length) {
      rows.push(grp('Below the line <small>(people &amp; support · excluded from run-rate)</small>'));
      cs.btl.forEach(x => {
        const en = PRICE[x.name] || {};
        rows.push(row(x.name, money(x.mo), { sub: 'est.' + (en.note ? ' · ' + en.note : ''), btl: true, calc: x.calc, why: en.why, ref: en.ref }));
      });
    }
    return `<div class="costbox">${rows.join('')}</div>`;
  }

  function bomHtml(comps) {
    const docFor = C().docFor;
    return comps.map(s => `<span>${s}${docFor(s) ? ' ' + infoIcon(docFor(s), s) : ''}</span>`).join('');
  }

  /* Hover tooltips on the rendered SVG nodes, from the NODE_PURPOSE catalog. */
  const nodeIdFromSvg = el => { const m = (el.id || '').match(/flowchart-([A-Za-z0-9]+)-\d+$/); return m ? m[1] : null; };
  function bindTooltips(host, arch) {
    const NP = C().NODE_PURPOSE;
    $$('.node', host).forEach(n => {
      const nid = nodeIdFromSvg(n);
      const purpose = (nid === 'Generator' && !arch.agent.multiAgent) ? NP.GeneratorSingle : NP[nid];
      if (!purpose) return;
      if (!n.querySelector(':scope > title')) {
        const ttl = document.createElementNS('http://www.w3.org/2000/svg', 'title');
        ttl.textContent = purpose;
        n.insertBefore(ttl, n.firstChild);
      }
      n.querySelectorAll('foreignObject div, .nodeLabel').forEach(el => el.setAttribute('title', purpose));
    });
  }

  /* Static tooltips and info icons on the left-panel inputs; applied once at init. */
  function applyInputHelp(purpose) {
    const HELP = NS.presets.INPUT_HELP;
    $$('section.config [data-bind]').forEach(el => {
      const ctl = el.closest('.ctl');
      const lab = ctl && ctl.querySelector(':scope > label');
      if (lab && HELP[el.dataset.bind]) lab.setAttribute('title', HELP[el.dataset.bind]);
    });
    const langLab = $('.ctl[data-vis="languages"] > label');
    if (langLab) langLab.setAttribute('title', HELP.languages);
    $$('#dataSources label').forEach(lab => {
      const cb = lab.querySelector('input'); if (!cb) return;
      const role = cb.value === 'bigquery'
        ? C().DATA_SOURCE_ROLE[purpose === 'automation' ? 'bigquery_automation' : 'bigquery_assistant']
        : C().DATA_SOURCE_ROLE[cb.value];
      if (role) lab.setAttribute('title', role);
      const comp = C().DS_COMPONENT[cb.value]; const doc = comp && C().COMPONENT_DOC[comp];
      if (doc && !lab.querySelector('.info-i')) lab.insertAdjacentHTML('beforeend', ' ' + infoIcon(doc, comp));
    });
  }

  function renderChips(state) {
    const chips = NS.presets.PRESETS[state.purpose];
    const active = state.preset && !state.custom;
    const pills = Object.entries(chips).map(([k, v]) => `<span class="chip ${active && state.preset === k ? 'active' : ''}" data-preset="${k}" title="${v.desc || ''}">${v.label}</span>`).join('');
    const fromLabel = state.preset ? (chips[state.preset] ? chips[state.preset].label : '') : '';
    const custom = state.custom ? `<span class="chip custom" title="Edited${fromLabel ? ' from ' + fromLabel : ''}. Click a preset to reload it.">Custom${fromLabel ? ' (from ' + fromLabel + ')' : ''}</span>` : '';
    $('#presetChips').innerHTML = pills + custom;
  }

  /* Terraform export checklist: the modal body shown before download. Three
     compact groups rendered from tfgen's structured placeholders/steps data
     (the same source as the tfvars comments and README sections, so the modal
     can never disagree with the bundle). Review-grade placeholders and notes
     stay README-only to keep this short; every line here is actionable. */
  function tfChecklistHtml(gen) {
    const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    const required = gen.placeholders.filter(p => p.kind === 'required');
    const gated = gen.placeholders.filter(p => p.kind === 'gated');
    const manual = gen.steps.filter(s => s.kind === 'step');
    const item = (tag, tagCls, code, why) =>
      `<div class="tf-item"><span class="tf-tag ${tagCls}">${tag}</span>${code ? `<code>${esc(code)}</code>` : ''}<span class="tf-why">${esc(why)}</span></div>`;
    let h = `<span class="close" id="modalClose" title="Close" aria-label="Close">&times;</span><h2>Generate Terraform</h2>`;
    h += `<div class="sub">The bundle is generated from the design as shown; nothing to fill in here. ` +
      `The values and steps below are placeholders in the bundle - terraform.tfvars and the README carry the same list.</div>`;
    h += `<div class="tf-group">Required before apply (plan stops until set)</div>`;
    h += required.map(p => item('required', 'req', p.var, p.why)).join('');
    if (gated.length) {
      h += `<div class="tf-group">Optional feature gates (empty = skipped, plan stays clean)</div>`;
      h += gated.map(p => item('gates ' + p.gatesWhat, 'gate', p.var, p.why)).join('');
    }
    if (manual.length) {
      h += `<div class="tf-group">Manual steps (not Terraform - details in the README)</div>`;
      h += manual.map(s => item(s.when === 'before-apply' ? 'before apply' : 'after apply', s.when === 'before-apply' ? 'before' : 'after', '', s.title)).join('');
    }
    h += `<div class="tf-actions"><button class="mini" id="tfDownload">Download Terraform .zip</button>` +
      `<span class="tf-foot">${Object.keys(gen.files).length} files · README.md has the full instructions</span></div>`;
    return h;
  }

  NS.render = {
    buildDecisionsPanel, updateDecisions, updateInputMarks, decodeValue,
    updateDataSourceMarks,
    issuesHtml, metricCards, perfPanelHtml, costPanelHtml, bomHtml, bindTooltips, applyInputHelp, renderChips,
    tfChecklistHtml,
  };
})(typeof window !== 'undefined' ? (window.ASD2 = window.ASD2 || {}) : (globalThis.ASD2 = globalThis.ASD2 || {}));
