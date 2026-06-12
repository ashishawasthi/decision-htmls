/* Agentic System Designer v2 - metrics, BoM gating, and pricing.
   All functions are pure over (arch, inputs); arch is the single derived model
   from asd2-derive.js, so the metrics, the BoM list, and the priced cost lines
   can never disagree about an architecture decision.
   Formulas ported from agentic-system-designer.html computeMetrics (1843-1954),
   bomHtml (2721-2761), and bomMonthlyCost (2802-2859). v2 deltas: no HNSW
   recall/ANN outputs (managed ScaNN stores), no Elasticsearch price line, and
   Memorystore is billed only when the Redis tier or response cache is the
   managed service (self-hosted Redis on GKE rides the GKE line instead).
   Rates live in the catalog PRICE book (list prices verified 2026-06-11);
   priceComponent returns { mo, calc } so every cost line carries the substituted
   formula it was computed from, and costSummary adds the below-the-line people
   and support estimates that never enter the GCP run-rate. */
(function (NS) {
  'use strict';
  const C = () => NS.catalog;

  function compute(arch, inputs) {
    const cat = C(), K = cat.K, i = inputs, m = {};
    const a = arch;
    const answerOnly = !!a.agent.answerOnly;
    const activeSecPerDay = i.activeHoursPerWeek * 3600 / 7;
    const dailyActions = i.actors * i.actionsPerDay;
    m.volAvg = dailyActions / activeSecPerDay;
    m.volPeak = m.volAvg * i.burst;
    m.volLabel = a.purpose === 'automation' ? 'concurrent runs' : 'QPS';
    m.tokensDay = dailyActions * (i.tokensIn + i.tokensOut);
    m.reqMo = dailyActions * 30.4;
    m.modelCallsMo = m.reqMo * (a.agent.modelCallsPerReq || 1);
    /* Response bytes leaving the platform, for the egress and interconnect lines. */
    m.egressGB = m.reqMo * i.tokensOut * K.net.bytesPerTok / 1e9;

    /* ---- token cost (managed API): explicit context-cache split ---- */
    const rm = cat.modelById(a.models.reasoningModel), fm = cat.modelById(a.models.fastModel);
    const reuse = a.caching.contextCache ? Math.min(0.9, (a.caching.reuseInputPct || 0) / 100) : 0;
    const callCost = mm => {
      const fresh = i.tokensIn * (1 - reuse) * mm.in / 1e6;
      const cached = i.tokensIn * reuse * (mm.cacheRead || 0) / 1e6;
      const out = i.tokensOut * mm.out / 1e6;
      return { fresh, cached, out, total: fresh + cached + out };
    };
    const groundPerCall = i.dataSources.includes('web') ? (rm.webSearch || 0) / 1000 : 0;
    const naiveTok = i.tokensIn * rm.in / 1e6 + i.tokensOut * rm.out / 1e6;
    m.costNaive = dailyActions * (naiveTok + groundPerCall) * 30.4;
    const f = a.models.smartRouting ? a.models.routingSplit / 100 : 0;
    const rc = callCost(rm), fc = callCost(fm);
    const blend = k => f * fc[k] + (1 - f) * rc[k];
    const respHit = Math.min(0.8, (a.caching.cacheHitBase || 0) / 100 + (a.caching.autocomplete ? 0.25 : 0) + (a.caching.warming ? 0.1 : 0));
    m.cacheHitEff = a.caching.responseCacheOn ? respHit : 0;
    const billed = dailyActions * (1 - m.cacheHitEff) * 30.4;
    m.costParts = {
      fresh: billed * blend('fresh'),
      cached: billed * blend('cached'),
      output: billed * blend('out'),
      grounding: billed * groundPerCall,
    };
    m.costOpt = m.costParts.fresh + m.costParts.cached + m.costParts.output + m.costParts.grounding;

    /* Calc strings for the cost panel, assembled from the same locals as the math
       above so the displayed formula can never drift from the number. */
    const nf = cat.nfmt, r3 = x => +(+x).toFixed(3);
    const rateIn = f * fm.in + (1 - f) * rm.in;
    const rateCache = f * (fm.cacheRead || 0) + (1 - f) * (rm.cacheRead || 0);
    const rateOut = f * fm.out + (1 - f) * rm.out;
    const split = a.models.smartRouting ? `${a.models.routingSplit}% ${fm.name} + ${100 - a.models.routingSplit}% ${rm.name}` : rm.name;
    const billedStr = m.cacheHitEff > 0
      ? `${nf(m.reqMo)} req x ${Math.round((1 - m.cacheHitEff) * 100)}% cache miss = ${nf(billed)} billed calls/mo`
      : `${nf(billed)} calls/mo`;
    m.costCalc = {
      fresh: `${billedStr} x ${nf(i.tokensIn * (1 - reuse))} fresh in-tok x $${r3(rateIn)}/M blended (${split})`,
      cached: reuse > 0 ? `${billedStr} x ${nf(i.tokensIn * reuse)} cached in-tok x $${r3(rateCache)}/M cache-read` : '',
      output: `${billedStr} x ${nf(i.tokensOut)} out-tok x $${r3(rateOut)}/M blended (${split})`,
      grounding: groundPerCall > 0 ? `${billedStr} x $${rm.webSearch}/1k searches (${rm.name}, 1 search per billed call)` : '',
      naive: `${nf(m.reqMo)} calls x (${nf(i.tokensIn)} in-tok x $${rm.in}/M + ${nf(i.tokensOut)} out-tok x $${rm.out}/M)${groundPerCall > 0 ? ` + $${rm.webSearch}/1k searches` : ''} on ${rm.name}, no cache or routing`,
      saved: `naive ${cat.money(m.costNaive)} - optimized ${cat.money(m.costOpt)}`,
      gpu: '',
    };
    if (answerOnly) {
      /* No model calls of ours: the grounded answer is generated inside Agent
         Search and billed in its per-query price, so the GenAI lines zero out. */
      m.costNaive = 0; m.costOpt = 0;
      m.costParts = { fresh: 0, cached: 0, output: 0, grounding: 0 };
      m.costCalc = { fresh: '', cached: '', output: '', grounding: '', naive: '', saved: '', gpu: '' };
    }

    /* ---- latency p95: critical-path line items; grounding fans out in parallel ---- */
    const L = K.lat;
    const genOf = mm => mm.ttftMs + i.tokensOut * mm.msPerOutTok;
    const gen = f * genOf(fm) + (1 - f) * genOf(rm);
    /* Output-streaming share of generation, blended across the routing split.
       Tagged onto the generation line item for the waterfall, and subtracted
       from the full p95 to get the first-token latency. */
    const streamMs = i.tokensOut * (f * fm.msPerOutTok + (1 - f) * rm.msPerOutTok);
    const genNote = a.models.smartRouting ? `${a.models.routingSplit}% ${fm.name} / ${100 - a.models.routingSplit}% ${rm.name}` : rm.name;
    const groundSubs = [];
    if (a.retrieval.ragOn) groundSubs.push({ label: 'Vector / hybrid retrieval', ms: L.retrieval });
    if (i.dataSources.includes('bigquery')) groundSubs.push({ label: 'BigQuery scan', ms: L.bigqueryScan });
    if (i.dataSources.includes('web')) groundSubs.push({ label: 'Web grounding (live search)', ms: L.webGround });
    const grounding = groundSubs.length ? Math.max(...groundSubs.map(s => s.ms)) : 0;
    const parts = [];
    const inbChips = a.models.inboundChips, outbChips = a.models.outboundChips;
    const inMs = inbChips.reduce((s, c) => s + (cat.IN_LAT[c] || 0), 0);
    const outMs = outbChips.reduce((s, c) => s + (cat.OUT_LAT[c] || 0), 0);
    const genGw = gen + outMs;
    if (inbChips.length) parts.push({ label: a.topology.privateOnly ? 'IAP / mTLS' : 'API Gateway', ms: inMs, note: a.topology.privateOnly ? 'private-path identity check (no public gateway)' : inbChips.join(' · ') });
    if (a.caching.responseCacheOn) parts.push({ label: 'Response cache lookup', ms: a.caching.semanticCache ? L.cacheSem : L.cacheExact, note: a.caching.semanticCache ? 'embed + ANN on miss' : 'key lookup on miss' });
    m.reviseCyclesP95 = 0;
    /* The streaming tail of whatever the user actually receives last: the
       user-facing generation for a single agent, the bundled answer on the
       no-agent path, nothing for a validator-gated team or async automation. */
    let finalStreamMs = 0;
    if (a.purpose === 'automation') {
      parts.push({ label: 'Orchestrator', ms: rm.ttftMs + i.tokensOut * rm.msPerOutTok / 2 + outMs, note: rm.name });
      if (groundSubs.length) parts.push({ label: 'Grounding', ms: grounding, parallel: groundSubs, note: 'parallel fan-out, slowest wins' });
      parts.push({ label: `Executor pool (x${a.agent.numAgents}, parallel)`, ms: genGw, note: 'agents concurrent, slowest wins' });
      parts.push({ label: 'Quality gate', ms: L.qualityGate });
    } else if (answerOnly) {
      /* No agent: Agent Search retrieves and generates the grounded answer
         inside the service. No external model call, no tools, no orchestration;
         the ~200-token answer rides a bundled Flash-Lite-class answerer. */
      const lite = cat.modelById('gemini-31-flash-lite');
      const ansStream = L.vaisAnswerTok * lite.msPerOutTok;
      finalStreamMs = ansStream;
      parts.push({ label: 'Agent Search answer (retrieve + generate)', ms: L.retrieval + lite.ttftMs + ansStream, stream: ansStream, note: `bundled Flash-Lite-class answerer, ~${L.vaisAnswerTok}-token grounded answer; no external agent, model call, or tool use` });
    } else if (a.agent.multiAgent) {
      /* Validated team: the Orchestrator plans once, the draft must COMPLETE
         before the Validator can read it (so no user-visible streaming), the
         Validator writes a short critique, and the p95 request pays every
         revise cycle that is still likelier than 5% (P(>=k cycles) = rate^k). */
      const shortCall = tok => f * (fm.ttftMs + tok * fm.msPerOutTok) + (1 - f) * (rm.ttftMs + tok * rm.msPerOutTok) + outMs;
      const planMs = shortCall(L.planTok), verdictMs = shortCall(L.verdictTok);
      const r = Math.min(0.95, Math.max(0, (a.agent.reviseRate || 0) / 100));
      const k95 = r > 0 ? Math.min(Math.max(0, a.agent.reactMaxIter - 1), Math.floor(Math.log(0.05) / Math.log(r))) : 0;
      m.reviseCyclesP95 = k95;
      parts.push({ label: 'Orchestrator plan & dispatch', ms: planMs, note: `~${L.planTok}-token plan, ${genNote}; later hand-offs are function calls` });
      if (groundSubs.length) parts.push({ label: 'Grounding', ms: grounding, parallel: groundSubs, note: 'parallel fan-out, slowest wins' });
      if (a.retrieval.mode === 'rerank') parts.push({ label: 'Rerank', ms: L.rerank });
      parts.push({ label: 'Generator draft (full output)', ms: genGw, note: 'the Validator reads the complete draft, so nothing streams to the user yet' });
      parts.push({ label: 'Validator verdict', ms: verdictMs, note: `~${L.verdictTok}-token critique, ${genNote}; draft prefill rides in the TTFT` });
      if (k95 > 0) parts.push({ label: `Revise loop (p95: ${k95} cycle${k95 > 1 ? 's' : ''}, cap ${Math.max(0, a.agent.reactMaxIter - 1)})`, ms: k95 * (genGw + verdictMs), note: `${a.agent.reviseRate}% of drafts fail validation; the p95 request pays every extra draft + verdict cycle still likelier than 5%` });
    } else {
      if (groundSubs.length) parts.push({ label: 'Grounding', ms: grounding, parallel: groundSubs, note: 'parallel fan-out, slowest wins' });
      if (a.retrieval.mode === 'rerank') parts.push({ label: 'Rerank', ms: L.rerank });
      finalStreamMs = streamMs;
      parts.push({ label: 'Generation (TTFT + output)', ms: genGw, stream: streamMs, note: outMs ? `${genNote} · +${Math.round(outMs)}ms model leg` : genNote });
    }
    m.latParts = parts;
    m.latencyP95 = parts.reduce((s, p) => s + p.ms, 0);
    m.latencyBudget = a.purpose === 'assistant' ? (cat.LATENCY_BUDGET[arch.effLatency] ?? Infinity) : Infinity;
    m.latencyOverBudget = m.latencyP95 > m.latencyBudget;
    /* First token of the final answer. A single agent streams as it generates,
       so start = full minus the output-streaming tail. A multi-agent team is
       validator-gated - the Validator only scores a complete draft - so the
       first answer token waits for the validated draft: start = full. The
       agentic SLO budgets start and full separately; automation runs async,
       so the start metric does not apply there. */
    if (a.purpose === 'assistant') {
      m.latencyStartIsGated = a.agent.multiAgent;
      m.latencyStartP95 = m.latencyStartIsGated ? m.latencyP95 : m.latencyP95 - finalStreamMs;
      m.latencyStartBudget = cat.LATENCY_BUDGET_START[arch.effLatency] ?? Infinity;
      m.latencyStartOverBudget = m.latencyStartP95 > m.latencyStartBudget;
    } else {
      m.latencyStartIsGated = false;
      m.latencyStartP95 = null;
      m.latencyStartBudget = Infinity;
      m.latencyStartOverBudget = false;
    }

    /* ---- vector index sizing (drives managed-store cost; ScaNN tuning is the service's job) ---- */
    /* CJK runs ~2-3 tokens/word vs ~1.3 for English: the same content roughly
       doubles, so all corpus-derived ingestion math scales by the multiplier. */
    m.ingestMult = (i.languages || []).some(l => K.lang.cjkLangs.includes(l)) ? K.lang.cjkIngestMult : 1;
    const chunks = (i.corpusSize || 0) * K.chunksPerDoc * m.ingestMult;
    m.indexBytes = chunks * K.dim * K.bytesPerFloat;
    m.indexGB = m.indexBytes / 1e9;
    m.shards = Math.max(1, Math.ceil(chunks / 1e8));

    /* ---- self-hosted inference fleet ---- */
    if (a.models.selfHostAny) {
      const g = K.gpu, ac = g.accel[a.sizing.accelerator] || g.accel.h100;
      const nodeTPS = Math.max(1, Math.round(g.nodeTokPerSec * (g.precMult[a.sizing.quant] || 1) * ac.tpsMult * (g.baseActiveB / g.refActiveB) * g.moePenalty / 2));
      const util = Math.min(1, Math.max(0.2, (a.sizing.gpuUtil || 70) / 100));
      const selfShare = (a.models.reasoningModel === 'llama4-selfhost' ? (1 - f) : 0) + (a.models.fastModel === 'llama4-selfhost' ? f : 0);
      const peakOutTPS = m.volPeak * i.tokensOut * selfShare;
      m.gpuNodes = Math.max(1, Math.ceil(peakOutTPS / (nodeTPS * util)));
      const hourly = (ac.costHr[a.sizing.gpuTier] != null) ? ac.costHr[a.sizing.gpuTier] : ac.costHr.on_demand;
      m.gpuTierLabel = (a.sizing.gpuTier || 'cud_3y').replace('_', ' ').toUpperCase();
      m.gpuUtilPct = Math.round(util * 100);
      m.gpuMo = m.gpuNodes * hourly * K.hoursMo;
      m.costCalc.gpu = `${m.gpuNodes} node(s) x $${hourly}/node-hr (${m.gpuTierLabel}) x ${K.hoursMo} hr; sized for ${nf(peakOutTPS)} peak out-tok/s at ${nf(nodeTPS)} tok/s per node x ${m.gpuUtilPct}% util`;
      /* Fleet capacity vs the peak it was sized for, for the capacity panel. */
      m.gpuNodeTPS = nodeTPS;
      m.gpuPeakOutTPS = peakOutTPS;
      m.gpuFleetTPS = m.gpuNodes * nodeTPS * util;
      m.gpuHeadroomPct = peakOutTPS > 0 ? (m.gpuFleetTPS / peakOutTPS - 1) * 100 : null;
    }

    /* ---- performance & capacity: the peak QPS funnel, concurrency, and ceilings ----
       Peak-hour basis throughout. The response cache serves its hit share, the
       agent sees the misses, model calls multiply by the agent fan-out, and every
       number carries the substituted formula it was computed from (m.perfCalc),
       so the panel can never drift from the math. */
    const PF = K.perf;
    const fan = answerOnly ? 0 : (a.agent.modelCallsPerReq || 1);
    m.qpsAgentPeak = m.volPeak * (1 - m.cacheHitEff);
    m.qpsModelPeak = m.qpsAgentPeak * fan;
    m.qpsRetrievalPeak = a.retrieval.ragOn ? m.qpsAgentPeak : 0;
    m.qpsLivePeak = (a.retrieval.liveSel || []).length && !answerOnly ? m.qpsAgentPeak : 0;
    m.qpsWebPeak = a.retrieval.hasWebGrounding && !answerOnly ? m.qpsAgentPeak : 0;
    /* Automation checkpoints after EACH step (crash = resume, not restart), so
       its state write rate is steps + read/close, not the assistant's flat 3. */
    const stateOps = a.purpose === 'automation' ? a.agent.reactMaxIter + 2 : PF.stateOpsPerReq;
    m.stateOpsPeak = a.state.drawn ? m.qpsAgentPeak * stateOps : 0;
    /* One node per ~100 peak QPS: the same figure the state-store, Cloud SQL,
       Spanner, and GKE burst-pod cost lines bill, so capacity and cost agree. */
    m.dbNodes = Math.max(1, Math.ceil((m.volPeak || 0) / 100));
    /* Little's law: requests in flight = arrival rate x time in system. */
    m.inflightPeak = m.qpsAgentPeak * m.latencyP95 / 1000;
    m.agentInstances = answerOnly ? null : Math.max(PF.instMin, Math.ceil(m.inflightPeak / PF.instConcurrency));
    m.tokInPeakSec = answerOnly ? 0 : m.qpsAgentPeak * i.tokensIn;
    m.tokOutPeakSec = answerOnly ? 0 : m.qpsAgentPeak * i.tokensOut;
    m.tokPerMinPeak = (m.tokInPeakSec + m.tokOutPeakSec) * 60;
    m.needsProvisionedThroughput = !a.models.selfHostAll && m.tokPerMinPeak > PF.ptTokMinThreshold;
    /* Automation: task success compounds per step (0.99^8 = 92%), the math that
       keeps agents narrow. Compounds over EXPECTED steps (capped at the narrow
       5-8 bound); the ReAct cap itself is the loop GUARD, deliberately ~1.5x
       above expected, so a guard of 12 is not punished as routine length. */
    if (a.purpose === 'automation') {
      m.runSuccessSteps = Math.min(a.agent.reactMaxIter, PF.maxAgentSteps);
      m.runSuccessPct = Math.pow(PF.stepSuccess, m.runSuccessSteps) * 100;
    }
    /* Managed ScaNN serving nodes: the wider of the size bound and the QPS bound.
       priceComponent reads m.vvsNodes, so the capacity row and the Vector Search
       cost line are the same number by construction. */
    const vvsShardGB = cat.PRICE['Vector Search'].rates.shardGB;
    if (m.indexGB > 0) {
      m.vvsNodesSize = Math.max(1, Math.ceil(m.indexGB / vvsShardGB));
      m.vvsNodesQps = Math.ceil(m.qpsRetrievalPeak / PF.vvsQpsPerNode);
      m.vvsNodes = Math.max(m.vvsNodesSize, m.vvsNodesQps);
    }
    /* Hybrid link load: every response rides the VLAN attachment (private-only
       ingress), so peak Mbps checks against the provisioned link, not the internet. */
    const vlanGbps = cat.PRICE['Cloud Interconnect + VLAN'].rates.vlanGbps;
    if (a.topology.hybridLink) {
      m.linkMbpsPeak = m.volPeak * (i.tokensIn + i.tokensOut) * K.net.bytesPerTok * 8 / 1e6;
      m.linkUtilPct = m.linkMbpsPeak / (vlanGbps * 1000) * 100;
    }
    m.perfCalc = {
      ingress: `${nf(m.volAvg, 2)} avg ${m.volLabel} x ${i.burst} burst`,
      cache: m.cacheHitEff > 0 ? `${nf(m.volPeak, 2)} peak x ${Math.round(m.cacheHitEff * 100)}% effective hit rate served from the cache` : '',
      agentQps: m.cacheHitEff > 0 ? `${nf(m.volPeak, 2)} peak x ${Math.round((1 - m.cacheHitEff) * 100)}% cache miss` : `${nf(m.volPeak, 2)} peak ${m.volLabel} passes straight through (no response cache in this design)`,
      modelQps: answerOnly ? 'no model calls of yours - the grounded answer is generated inside Agent Search' : `${nf(m.qpsAgentPeak, 2)} agent-side peak x ${fan} model calls/req (agents x damped ReAct loop)`,
      inflight: `${nf(m.qpsAgentPeak, 2)} agent-side peak/s x ${nf(m.latencyP95 / 1000, 2)} s in system (Little's law: L = lambda x W)`,
      instances: answerOnly ? 'managed answer API - autoscaling is the service side of the contract' : `ceil(${nf(m.inflightPeak, 1)} in-flight / ${PF.instConcurrency} concurrent streams per instance), floor of ${PF.instMin} for HA`,
      tok: answerOnly ? 'no model quota of yours - Agent Search bundles the answer generation' : `${nf(m.qpsAgentPeak, 2)} agent-side peak/s x (${nf(i.tokensIn)} in + ${nf(i.tokensOut)} out) tokens x 60 s = ${nf(m.tokPerMinPeak)} tok/min`,
      state: a.state.drawn ? `${nf(m.qpsAgentPeak, 2)} agent-side peak/s x ${stateOps} state ops/${a.purpose === 'automation' ? 'run (checkpoint after each step + read/close)' : 'req'}; ${m.dbNodes} node(s) at ~100 peak QPS each` : '',
      vvs: m.vvsNodes ? `max(size: ${m.vvsNodesSize} node(s) at ~${vvsShardGB} GB each, load: ${m.vvsNodesQps} node(s) at ~${PF.vvsQpsPerNode} QPS each on ${nf(m.qpsRetrievalPeak, 1)} retrieval QPS)` : '',
      link: m.linkMbpsPeak != null ? `${nf(m.volPeak, 2)} peak/s x ${nf(i.tokensIn + i.tokensOut)} tok x ${K.net.bytesPerTok} B x 8 bits vs the ${vlanGbps} Gbps VLAN attachment` : '',
      gpu: m.gpuFleetTPS ? `${m.gpuNodes} node(s) x ${nf(m.gpuNodeTPS)} tok/s x ${m.gpuUtilPct}% util = ${nf(m.gpuFleetTPS)} tok/s vs ${nf(m.gpuPeakOutTPS)} required at peak` : '',
    };
    return m;
  }

  /* Metric-driven lints, appended to the derive() lints. */
  function lint(arch, m, inputs) {
    const cat = C(), out = [];
    const add = (sev, msg, save, src) => out.push({ sev, msg, save: save || '', src });
    if (m.volPeak > cat.K.apigeeRpsPerRegion / 1000 && !arch.topology.multiRegion) add('scaling', 'Peak load nears single-region quota - shard by region + pre-negotiate.', '', 'multiRegion');
    if (arch.purpose === 'automation') {
      const needsSpanner = arch.topology.multiRegion || m.volPeak > 50;
      if (arch.state.store.includes('spanner') && !needsSpanner) add('cost', 'Spanner is selected but this is a single-region, moderate-write design - AlloyDB is the simpler, cheaper regional default and still does HA, read pools, and cross-region DR.', 'cost down', 'stateStore');
      else if (needsSpanner && !arch.state.store.includes('spanner')) add('scaling', `This design needs ${arch.topology.multiRegion ? 'active-active multi-region writes' : 'very high peak write throughput'} - move the state store to Spanner for horizontal write scale. AlloyDB caps at single-primary regional writes.`, '', 'stateStore');
    }
    if (m.latencyOverBudget) {
      const slow = inputs.dataSources.filter(s => cat.LATENCY_HEAVY.includes(s)).map(s => cat.SRC_LABEL[s] || s);
      const budget = m.latencyBudget >= 1000 ? (m.latencyBudget / 1000) + 's' : m.latencyBudget + 'ms';
      add('conflict', `Latency p95 (${Math.round(m.latencyP95)}ms) exceeds the ${arch.effLatency === 'subsecond' ? 'sub-second' : arch.effLatency} SLO (${budget})${slow.length ? ', driven by ' + slow.join(', ') + ' on the hot path' : ''}. Remove the slow source or raise the SLO.`, 'latency down', 'latencyPreset');
    }
    if (m.latencyStartOverBudget) {
      const sb = m.latencyStartBudget >= 1000 ? (m.latencyStartBudget / 1000) + 's' : m.latencyStartBudget + 'ms';
      const why = m.latencyStartIsGated
        ? 'the team is validator-gated, so the user sees nothing until the validated draft clears the loop. Cut the revise rate or answer length, drop to a single streaming agent'
        : 'everything before streaming starts (grounding, model TTFT) must fit it. Remove the slow source, bias routing to the fast model';
      add('conflict', `First token p95 (${Math.round(m.latencyStartP95)}ms) exceeds the ${sb} start budget of the agentic SLO - ${why}, or raise the SLO.`, 'latency down', 'latencyPreset');
    }
    if (m.needsProvisionedThroughput) add('scaling', `Peak model throughput (~${cat.fmt(m.tokPerMinPeak, 1)} tok/min) rides dynamic shared quota, which does not guarantee capacity - reserve Provisioned Throughput for the steady share so p95 holds at peak.`, '', 'modelStrategy');
    if (m.linkUtilPct != null && m.linkUtilPct > cat.K.perf.linkSatPct) add('scaling', `Peak traffic uses ~${Math.round(m.linkUtilPct)}% of the interconnect VLAN attachment - add a second VLAN or resize the link before it saturates.`, '', 'deployment');
    if (arch.purpose === 'assistant' && arch.effLatency === 'subsecond' && !arch.caching.autocomplete && (m.cacheHitEff || 0) < 0.3) add('caching', 'Sub-second p95 depends on cache hits - enable query autocomplete plus exact or semantic cache so the popular head returns without full inference.', 'latency down', 'autocomplete');
    return out;
  }

  /* The single BoM gating source: every component name this design provisions.
     Both the BoM chip list and the priced cost lines consume this. */
  function components(arch, inputs) {
    const a = arch, i = inputs, b = new Set();
    /* The no-agent path provisions no agent platform, models, state store, or
       Model Armor: Agent Search answers directly and bundles its answerer. */
    if (!a.agent.answerOnly) {
      if (a.agent.gke) b.add('GKE Autopilot (agent)');
      else b.add(a.agent.platform === 'adk' ? 'ADK + Agent Runtime' : a.agent.platform === 'studio' ? 'Agent Studio' : 'LangGraph');
      if (a.agent.platform === 'langgraph') { b.add('LangGraph'); b.add('Self-managed infra + ops (LangGraph)'); b.add('LangGraph Platform Enterprise (self-host license)'); }
    }
    if (a.gov.gateway) { b.add('Cloud IAP'); if (!a.topology.privateOnly) { b.add('Cloud API Gateway'); b.add('Apigee'); } }
    if (a.gov.auditLog) b.add('Cloud Logging (WORM)');
    if ((a.retrieval.storeDrawn || a.agent.answerOnly) && a.retrieval.ragEngine === 'vais') {
      b.add('Agent Search');
    } else if (a.retrieval.storeDrawn) {
      b.add(a.retrieval.vectorDB === 'vertex' ? 'Vector Search' : 'AlloyDB');
      if (a.retrieval.mode === 'hybrid' || a.retrieval.mode === 'rerank') b.add('BM25');
      if (a.retrieval.ingestionSep || i.dataSources.includes('website')) b.add('Dataflow');
      if (i.dataSources.includes('doc_corpus') || i.dataSources.includes('website')) b.add('Document AI');
      /* The self-built pipeline pays for the embedding model; Agent Search bundles it. */
      if ((i.corpusSize || 0) > 0) b.add('Embeddings (ingestion)');
    }
    /* De-identification before embedding/indexing applies to both engines:
       Agent Search has no built-in de-id, so the managed path pre-processes. */
    if (a.retrieval.dlpDeidIngest) b.add('Cloud DLP (ingest de-identify)');
    if (i.dataSources.includes('bigquery') && !a.agent.answerOnly) b.add('BigQuery');
    if (a.state.drawn) b.add(a.state.store.includes('spanner') ? 'Spanner' : a.state.store.includes('alloydb') ? 'AlloyDB (state)' : a.state.store === 'redis' ? 'Memorystore Cluster' : 'Cloud SQL');
    /* Managed Memorystore: the Redis hot tier when it is not self-hosted on GKE,
       and the managed response cache. Self-hosted Redis rides the GKE line. */
    if ((a.state.drawn && a.state.redisTier && !a.state.redisSelf) || (a.caching.responseCacheOn && !a.agent.gke)) b.add('Memorystore Cluster');
    b.add('Cloud Trace'); b.add('Agent Platform Evals');
    if (a.gov.guardrails && !a.agent.answerOnly) b.add('Model Armor');
    if (a.gov.toolAuthz) b.add('Workload Identity');
    if (a.gov.modelRiskGov) b.add('Model Registry');
    if (a.security.enforceVpcSc) b.add('VPC Service Controls');
    b.add('Cloud DLP'); b.add('IAM');
    if (a.security.dataAccessAudit) b.add('Cloud Audit Logs (Data Access)');
    b.add('Cloud Storage');
    if (a.security.secretManagerOn) b.add('Secret Manager');
    if (a.security.cmek) b.add('Cloud KMS');
    if (a.purpose === 'automation') b.add('Pub/Sub');
    if (a.models.selfHostAny) b.add('vLLM on GKE');
    if (a.topology.hybridLink) b.add('Cloud Interconnect + VLAN');
    if (!a.agent.answerOnly) [a.models.reasoningModel, a.models.fastModel].forEach(id => b.add(C().modelById(id).name));
    return [...b];
  }

  /* Estimated monthly $ for a BoM component: { mo, calc } with the substituted
     formula string, { mo: 0, calc: '' } when bundled/free, null when not modeled.
     Static rates, notes, and reference links live in the catalog PRICE book; the
     formulas live here so calc strings are built next to the math they describe. */
  function priceComponent(name, m, inputs) {
    const cat = C(), K = cat.K, nf = cat.nfmt, i = inputs;
    const e = cat.PRICE[name];
    if (!e) return null;
    if (e.free) return { mo: 0, calc: '' };
    const R = m.reqMo != null ? m.reqMo : i.actors * i.actionsPerDay * 30.4;
    const Tk = m.tokensDay * 30.4;
    const dbNodes = m.dbNodes != null ? m.dbNodes : Math.max(1, Math.ceil((m.volPeak || 0) / 100));
    const docsDay = Math.round((i.corpusSize || 0) * K.ingestion.docsPerDayFactor);
    const pages = K.ingestion.docPages;
    const H = K.hoursMo;
    const runtimeF = r => {
      const perReq = (r.vcpuSecPerReq * r.vcpuHr + r.gibSecPerReq * r.gibHr) / 3600;
      return { mo: r.baseMo + R * perReq, calc: `$${r.baseMo} base + ${nf(R)} req x $${+perReq.toFixed(5)}/req (~${r.vcpuSecPerReq} vCPU-s x $${r.vcpuHr}/vCPU-hr + ${r.gibSecPerReq} GiB-s x $${r.gibHr}/GiB-hr)` };
    };
    const F = {
      'ADK + Agent Runtime': runtimeF,
      'Agent Studio': runtimeF,
      'LangGraph': () => ({ mo: 0, calc: 'open source (MIT): no license fee for the framework itself' }),
      'Self-managed infra + ops (LangGraph)': r => ({ mo: r.baseMo + dbNodes * r.perNodeMo + R * r.perReq, calc: `$${r.baseMo} floor (K8s + Postgres + Redis + monitoring) + ${dbNodes} concurrency node x $${r.perNodeMo} + ${nf(R)} runs x $${r.perReq}` }),
      'LangGraph Platform Enterprise (self-host license)': r => ({ mo: r.mo, calc: `flat $${nf(r.mo)}/mo, the illustrative midpoint of custom enterprise quotes` }),
      'Apigee': r => ({ mo: r.envMo + R / 1e6 * r.perMCalls, calc: `$${r.envMo} Base environment + ${nf(R)} calls x $${r.perMCalls}/M (Standard proxies)` }),
      'Cloud API Gateway': r => {
        const over = Math.max(0, R - r.freeMCalls * 1e6);
        return { mo: over / 1e6 * r.perMCalls, calc: over > 0 ? `(${nf(R)} - ${r.freeMCalls}M free) calls x $${r.perMCalls}/M` : `${nf(R)} calls/mo, inside the ${r.freeMCalls}M/mo free tier` };
      },
      'Cloud Logging (WORM)': r => {
        const gib = Tk * r.logBytesPerTok / 2 ** 30;
        const ingest = Math.max(0, gib - r.freeGiB) * r.ingestPerGiB;
        const hold = gib * r.retainMo * r.retainPerGiBMo;
        return { mo: r.baseMo + ingest + hold, calc: `${nf(Tk / 1e6)}M tok x ${r.logBytesPerTok} B = ${nf(gib, 1)} GiB/mo; ingest past ${r.freeGiB} GiB free = $${nf(ingest)} + ${r.retainMo}-mo WORM hold at $${r.retainPerGiBMo}/GiB-mo = $${nf(hold)} + $${r.baseMo} base` };
      },
      'Cloud Audit Logs (Data Access)': r => {
        const gib = R * r.entriesPerReq * r.kibPerEntry / 2 ** 20;
        return { mo: r.baseMo + gib * r.perGiB, calc: `${nf(R)} req x ${r.entriesPerReq} entries x ${r.kibPerEntry} KiB = ${nf(gib, 1)} GiB x $${r.perGiB}/GiB + $${r.baseMo} base` };
      },
      'Vector Search': r => {
        const nodes = m.indexGB > 0 ? (m.vvsNodes || Math.max(1, Math.ceil(m.indexGB / r.shardGB))) : 0;
        const bound = m.vvsNodesQps > m.vvsNodesSize ? `QPS-bound: ${m.vvsNodesQps} node(s) for peak retrieval load vs ${m.vvsNodesSize} for the ${nf(m.indexGB, 1)} GB index` : `size-bound: 1 node per ~${r.shardGB} GB on a ${nf(m.indexGB, 1)} GB index`;
        return { mo: nodes * r.nodeHr * H, calc: nodes ? `${nodes} x ${r.nodeType} x $${r.nodeHr}/hr x ${H} hr (${bound})` : '' };
      },
      'Agent Search': r => {
        const q = R * r.per1kQueries / 1000;
        const stGiB = Math.max(0, (m.indexGB || 0) - r.freeGiB);
        const site = i.dataSources.includes('website') ? r.websiteBase : 0;
        return { mo: q + stGiB * r.storageGiB + site, calc: `${nf(R)} queries x $${r.per1kQueries}/1k (Enterprise) = $${nf(q)} + ${nf(stGiB, 1)} GiB past the ${r.freeGiB} GiB free x $${r.storageGiB} = $${nf(stGiB * r.storageGiB)}${site ? ` + $${site} website store` : ''}` };
      },
      'AlloyDB': r => {
        const base = (r.baseVcpu * r.vcpuHr + r.baseGiB * r.gibHr) * H;
        return { mo: base + m.indexGB * r.storagePerGB, calc: `${r.baseVcpu} vCPU / ${r.baseGiB} GiB primary x ${H} hr = $${nf(base)} + ${nf(m.indexGB, 1)} GB x $${r.storagePerGB}/GB-mo storage` };
      },
      'AlloyDB (state)': r => {
        const base = (r.baseVcpu * r.vcpuHr + r.baseGiB * r.gibHr) * H;
        const pool = (r.poolVcpu * r.vcpuHr + r.poolGiB * r.gibHr) * H;
        return { mo: base + dbNodes * pool + m.indexGB * r.storagePerGB, calc: `primary $${nf(base)} + ${dbNodes} read-pool node x $${nf(pool)} + ${nf(m.indexGB, 1)} GB x $${r.storagePerGB} storage` };
      },
      'Dataflow': r => docsDay > 0
        ? { mo: r.baseMo + docsDay * r.perDoc, calc: `$${r.baseMo} daily-batch floor + ${nf(docsDay)} changed docs/day x $${r.perDoc}` }
        : { mo: 0, calc: '' },
      'Document AI': r => {
        const blended = (1 - r.complexShare) * r.perPageOcr + r.complexShare * r.perPageLayout;
        const mo = docsDay * pages * 30.4 * blended;
        return { mo, calc: mo > 0 ? `${nf(docsDay)} docs/day x ${pages} pages x 30.4 days, classify-first blend: ${Math.round((1 - r.complexShare) * 100)}% OCR x $${r.perPageOcr * 1000}/1k + ${Math.round(r.complexShare * 100)}% complex layout x $${r.perPageLayout * 1000}/1k` : '' };
      },
      'BigQuery': r => {
        const tib = (R * K.bqScanMB) / 1048576;
        const overTib = Math.max(0, tib - r.scanFreeTiB);
        const store = Math.max(0, r.storedGB - r.storeFreeGB) * r.storePerGB;
        return { mo: overTib * r.scanPerTiB + store, calc: `${nf(R)} req x ${K.bqScanMB} MB = ${nf(tib, 1)} TiB scanned; ${nf(overTib, 1)} TiB past the ${r.scanFreeTiB} TiB free x $${r.scanPerTiB} = $${nf(overTib * r.scanPerTiB)} + ${r.storedGB - r.storeFreeGB} GB stored x $${r.storePerGB} = $${nf(store)}` };
      },
      'Spanner': r => ({ mo: dbNodes * r.nodeHr * H + m.indexGB * r.storagePerGB, calc: `${dbNodes} node x $${r.nodeHr}/hr x ${H} hr (Standard edition, 3 replicas included) + ${nf(m.indexGB, 1)} GiB x $${r.storagePerGB} storage` }),
      'Cloud SQL': r => ({ mo: r.baseMo + dbNodes * r.replicaMo, calc: `HA primary (2 vCPU / 8 GiB) $${r.baseMo} + ${dbNodes} read replica x $${r.replicaMo}` }),
      'Memorystore Cluster': r => ({ mo: r.nodes * r.nodeHr * H, calc: `${r.nodes} x shared-core-nano x $${r.nodeHr}/hr x ${H} hr` }),
      'GKE Autopilot (agent)': r => {
        const base = r.clusterFeeMo + (r.baseVcpu * r.vcpuHr + r.baseGib * r.gibHr) * H;
        const per = (r.perNodeVcpu * r.vcpuHr + r.perNodeGib * r.gibHr) * H;
        return { mo: base + dbNodes * per, calc: `$${r.clusterFeeMo} cluster fee + ${r.baseVcpu} vCPU / ${r.baseGib} GiB agent pods = $${nf(base)} + ${dbNodes} burst pod x $${nf(per)}` };
      },
      'Cloud Storage': r => ({ mo: (r.baseGB + (m.indexGB || 0)) * r.perGB, calc: `(${r.baseGB} GB docs + artifacts + ${nf(m.indexGB || 0, 1)} GB index) x $${r.perGB}/GB-mo` }),
      'Secret Manager': r => ({ mo: r.versions * r.versionMo + r.accessMo, calc: `${r.versions} secret versions x $${r.versionMo} + ~$${r.accessMo} access ops` }),
      'Cloud KMS': r => {
        const ops = R * r.opsPerReq;
        return { mo: r.keyVersions * r.keyVersionMo + ops / 1e4 * r.per10kOps, calc: `${r.keyVersions} key versions x $${r.keyVersionMo} + ${nf(ops)} ops (${r.opsPerReq}/req, DEKs cached) x $${r.per10kOps}/10k` };
      },
      'Pub/Sub': r => {
        const tib = R * r.msgKB / 2 ** 30;
        return { mo: r.baseMo + tib * r.perTiB, calc: `${nf(R)} msgs x ${r.msgKB} KiB = ${nf(tib * 1024, 1)} GiB x $${r.perTiB}/TiB + $${r.baseMo} floor` };
      },
      'Cloud Trace': r => {
        const ms = R * r.spansPerReq / 1e6;
        const over = Math.max(0, ms - r.freeMSpans);
        return { mo: over * r.perMSpans, calc: `${nf(R)} req x ${r.spansPerReq} spans = ${nf(ms, 1)}M spans; ${nf(over, 1)}M past the ${r.freeMSpans}M free x $${r.perMSpans}/M` };
      },
      'Agent Platform Evals': r => {
        const evals = R * r.samplePct / 100;
        return { mo: evals * r.perEval, calc: `${nf(R)} req x ${r.samplePct}% sample = ${nf(evals)} evals x $${r.perEval} judge tokens` };
      },
      'Model Armor': r => {
        const mtok = Tk * r.screenMult / 1e6;
        const over = Math.max(0, mtok - r.freeMTok);
        return { mo: over * r.perMTok, calc: `${nf(Tk / 1e6)}M tok x ${r.screenMult} (prompt + response) = ${nf(mtok)}M screened; ${nf(over)}M past the ${r.freeMTok}M free x $${r.perMTok}/M` };
      },
      'Cloud DLP': r => {
        const gb = Tk * K.net.bytesPerTok / 1e9;
        const over = Math.max(0, gb - r.freeGB);
        return { mo: over * r.perGB, calc: `${nf(Tk / 1e6)}M tok x ${K.net.bytesPerTok} B = ${nf(gb, 1)} GB inspected; ${nf(over, 1)} GB past the ${r.freeGB} GB free x $${r.perGB}/GB` };
      },
      'vLLM on GKE': r => ({ mo: r.clusterFeeMo, calc: `GKE cluster fee $0.10/hr x ${H} hr (GPU nodes are the fleet line above)` }),
      'Cloud Interconnect + VLAN': r => {
        const attach = r.vlanHr * H;
        return { mo: attach + (m.egressGB || 0) * r.perGB, calc: `${r.vlanGbps} Gbps Partner VLAN $${r.vlanHr}/hr x ${H} hr = $${nf(attach)} + ${nf(m.egressGB || 0, 1)} GB over the link x $${r.perGB}/GB` };
      },
      'Network egress (internet)': r => {
        const over = Math.max(0, (m.egressGB || 0) - r.freeGB);
        return { mo: over * r.perGB, calc: `${nf(R)} resp x ${nf(i.tokensOut)} tok x ${K.net.bytesPerTok} B = ${nf(m.egressGB || 0, 1)} GB; ${nf(over, 1)} GB past the ${r.freeGB} GiB free x $${r.perGB}/GB (Premium tier)` };
      },
      'Embeddings (ingestion)': r => {
        const mult = m.ingestMult || 1;
        const tokMo = (i.corpusSize || 0) * K.ingestion.docsPerDayFactor * 30.4 * K.chunksPerDoc * K.ingestion.tokensPerChunk * mult;
        const back = (i.corpusSize || 0) * K.chunksPerDoc * K.ingestion.tokensPerChunk * mult;
        const mo = tokMo / 1e6 * r.perMTok;
        return { mo, calc: mo > 0 ? `refresh ${nf(tokMo / 1e6)}M tok/mo x $${r.perMTok}/M${mult > 1 ? ` (x${mult} CJK)` : ''}; one-time backfill ${nf(back / 1e9, 1)}B tok at the $${r.batchPerMTok}/M batch tier = $${nf(back / 1e6 * r.batchPerMTok)} (not in the total; an embedding model swap re-runs it in full)` : '' };
      },
      'Cloud DLP (ingest de-identify)': r => {
        const mult = m.ingestMult || 1;
        const gbMo = (i.corpusSize || 0) * K.ingestion.docsPerDayFactor * 30.4 * K.chunksPerDoc * K.ingestion.tokensPerChunk * K.net.bytesPerTok * mult / 1e9;
        const backGB = (i.corpusSize || 0) * K.chunksPerDoc * K.ingestion.tokensPerChunk * K.net.bytesPerTok * mult / 1e9;
        const mo = Math.max(0, gbMo - r.freeGB) * r.perGB;
        return { mo, calc: gbMo > 0 ? `refresh ${nf(gbMo, 1)} GB/mo past the ${r.freeGB} GB free x $${r.perGB}/GB de-identified before embedding (SDP storage de-id job); one-time backfill ${nf(backGB, 1)} GB = $${nf(backGB * r.perGB)} (not in the total)` : '' };
      },
    };
    const fmla = F[name];
    return fmla ? fmla(e.rates) : null;
  }

  const unpricedReason = () => ({ short: 'usage not modeled', why: 'Spend is usage-dependent and not modeled here, so this line is shown as not modeled.' });

  /* Below-the-line ops labor for the self-managed paths: an opportunity-cost
     estimate of build vs buy, never part of the GCP run-rate. Returns [] for
     fully managed designs. */
  function laborLines(arch, m) {
    const cat = C(), nf = cat.nfmt, r = cat.PRICE['Ops & on-call labor (build vs buy)'].rates;
    const parts = [];
    if (arch.agent.gke) parts.push([r.gkeFte, 'GKE platform ops']);
    if (arch.models.selfHostAny) parts.push([Math.max(r.gpuMinFte, (m.gpuNodes || 0) / r.gpuNodesPerFte), 'inference fleet ops']);
    if (arch.agent.platform === 'langgraph') parts.push([r.langgraphFte, 'self-managed LangGraph runtime']);
    if (!parts.length) return [];
    const fte = parts.reduce((s, p) => s + p[0], 0);
    return [{
      name: 'Ops & on-call labor (build vs buy)',
      mo: fte * r.ftePerMo,
      calc: `${parts.map(p => `${+p[0].toFixed(2)} FTE ${p[1]}`).join(' + ')} = ${+fte.toFixed(2)} FTE x $${nf(r.ftePerMo)}/mo fully loaded`,
    }];
  }

  /* Splits the BoM into priced / unpriced / free, sums platform $, returns the
     combined monthly run-rate plus the below-the-line (people and support) group,
     the per-1k-requests rate, and the calc strings for the total rows. */
  function costSummary(arch, m, inputs) {
    const cat = C(), nf = cat.nfmt;
    const genai = (m.costOpt || 0) + (m.gpuMo || 0);
    const models = new Set([cat.modelById(arch.models.reasoningModel).name, cat.modelById(arch.models.fastModel).name]);
    const comps = components(arch, inputs).filter(n => !models.has(n));
    /* Internet egress is billed but is not a provisioned component, so it joins the
       priced list without a BoM chip: external/public designs on GCP only (hybrid
       is private-only ingress; its link egress rides the interconnect line). */
    const sens = cat.SENS[inputs.audienceSensitivity];
    if (inputs.deployment === 'gcp' && sens && sens.aud !== 'internal') comps.push('Network egress (internet)');
    const priced = [], red = [], free = [];
    comps.forEach(name => {
      const est = priceComponent(name, m, inputs);
      if (est == null) red.push({ name, ...unpricedReason() });
      else if (est.mo === 0 && !est.calc) free.push(name);
      else priced.push({ name, mo: est.mo, calc: est.calc });
    });
    const platMo = priced.reduce((s, x) => s + x.mo, 0);
    const totalMo = genai + platMo;
    /* Below the line: ops labor plus the support plan, computed on the run-rate. */
    const btl = laborLines(arch, m);
    const sr = cat.PRICE['Enterprise support (Enhanced)'].rates;
    let fee = 0, lo = 0;
    for (const [cap, rate] of sr.tiers) { fee += Math.max(0, Math.min(totalMo, cap) - lo) * rate; lo = cap; if (totalMo <= cap) break; }
    const supMo = Math.max(sr.minMo, fee);
    btl.push({ name: 'Enterprise support (Enhanced)', mo: supMo, calc: `the greater of the $${sr.minMo}/mo minimum or tiered % of the $${nf(totalMo)} run-rate (10% to $10k, then 7% / 5% / 3%)` });
    const btlMo = btl.reduce((s, x) => s + x.mo, 0);
    const reqMo = m.reqMo || 0;
    const perK = reqMo > 0 ? totalMo / reqMo * 1000 : 0;
    const calc = {
      plat: `sum of ${priced.length} priced platform lines${red.length ? ` (${red.length} unpriced excluded)` : ''}`,
      total: `GenAI $${nf(genai)} + platform $${nf(platMo)}`,
      perK: `$${nf(totalMo)} / ${nf(reqMo)} req x 1k`,
    };
    return { genai, priced, red, free, platMo, totalMo, perK, calc, btl, btlMo };
  }

  NS.metrics = { compute, lint, components, priceComponent, laborLines, costSummary };
})(typeof window !== 'undefined' ? (window.ASD2 = window.ASD2 || {}) : (globalThis.ASD2 = globalThis.ASD2 || {}));
