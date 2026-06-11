/* Agentic System Designer v2 - metrics, BoM gating, and pricing.
   All functions are pure over (arch, inputs); arch is the single derived model
   from asd2-derive.js, so the metrics, the BoM list, and the priced cost lines
   can never disagree about an architecture decision.
   Formulas ported from agentic-system-designer.html computeMetrics (1843-1954),
   bomHtml (2721-2761), and bomMonthlyCost (2802-2859). v2 deltas: no HNSW
   recall/ANN outputs (managed ScaNN stores), no Elasticsearch price line, and
   Memorystore is billed only when the Redis tier or response cache is the
   managed service (self-hosted Redis on GKE rides the GKE line instead). */
(function (NS) {
  'use strict';
  const C = () => NS.catalog;

  function compute(arch, inputs) {
    const cat = C(), K = cat.K, i = inputs, m = {};
    const a = arch;
    const activeSecPerDay = i.activeHoursPerWeek * 3600 / 7;
    const dailyActions = i.actors * i.actionsPerDay;
    m.volAvg = dailyActions / activeSecPerDay;
    m.volPeak = m.volAvg * i.burst;
    m.volLabel = a.purpose === 'automation' ? 'concurrent runs' : 'QPS';
    m.tokensDay = dailyActions * (i.tokensIn + i.tokensOut);

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

    /* ---- latency p95: critical-path line items; grounding fans out in parallel ---- */
    const L = K.lat;
    const genOf = mm => mm.ttftMs + i.tokensOut * mm.msPerOutTok;
    const gen = f * genOf(fm) + (1 - f) * genOf(rm);
    const genNote = a.models.smartRouting ? `${a.models.routingSplit}% ${fm.name} / ${100 - a.models.routingSplit}% ${rm.name}` : rm.name;
    const groundSubs = [];
    if (a.retrieval.ragOn) groundSubs.push({ label: 'Vector / hybrid retrieval', ms: L.retrieval });
    if (i.dataSources.includes('bigquery')) groundSubs.push({ label: 'BigQuery scan', ms: L.bigqueryScan });
    if (i.dataSources.includes('web')) groundSubs.push({ label: 'Web grounding (live search)', ms: L.webGround });
    if (i.dataSources.includes('onprem')) groundSubs.push({ label: 'On-prem call', ms: L.onpremCall });
    const grounding = groundSubs.length ? Math.max(...groundSubs.map(s => s.ms)) : 0;
    const parts = [];
    const inbChips = a.models.inboundChips, outbChips = a.models.outboundChips;
    const inMs = inbChips.reduce((s, c) => s + (cat.IN_LAT[c] || 0), 0);
    const outMs = outbChips.reduce((s, c) => s + (cat.OUT_LAT[c] || 0), 0);
    const genGw = gen + outMs;
    if (inbChips.length) parts.push({ label: a.topology.privateOnly ? 'IAP / mTLS' : 'API Gateway', ms: inMs, note: a.topology.privateOnly ? 'private-path identity check (no public gateway)' : inbChips.join(' · ') });
    if (a.caching.responseCacheOn) parts.push({ label: 'Response cache lookup', ms: a.caching.semanticCache ? L.cacheSem : L.cacheExact, note: a.caching.semanticCache ? 'embed + ANN on miss' : 'key lookup on miss' });
    if (a.purpose === 'automation') {
      parts.push({ label: 'Orchestrator', ms: rm.ttftMs + i.tokensOut * rm.msPerOutTok / 2 + outMs, note: rm.name });
      if (groundSubs.length) parts.push({ label: 'Grounding', ms: grounding, parallel: groundSubs, note: 'parallel fan-out, slowest wins' });
      parts.push({ label: `Executor pool (x${a.agent.numAgents}, parallel)`, ms: genGw, note: 'agents concurrent, slowest wins' });
      parts.push({ label: 'Quality gate', ms: L.qualityGate });
    } else {
      if (groundSubs.length) parts.push({ label: 'Grounding', ms: grounding, parallel: groundSubs, note: 'parallel fan-out, slowest wins' });
      if (a.retrieval.mode === 'rerank') parts.push({ label: 'Rerank', ms: L.rerank });
      parts.push({ label: 'Generation (TTFT + output)', ms: genGw, note: outMs ? `${genNote} · +${Math.round(outMs)}ms model leg` : genNote });
      if (a.agent.multiAgent) parts.push({ label: `ReAct loop (x${a.agent.reactMaxIter} iter)`, ms: ((a.retrieval.mode === 'rerank' ? L.rerank : 0) + genGw) * a.agent.reactMaxIter * 0.12, note: 'sequential iterations' });
    }
    m.latParts = parts;
    m.latencyP95 = parts.reduce((s, p) => s + p.ms, 0);
    m.latencyBudget = a.purpose === 'assistant' ? (cat.LATENCY_BUDGET[arch.effLatency] ?? Infinity) : Infinity;
    m.latencyOverBudget = m.latencyP95 > m.latencyBudget;

    /* ---- vector index sizing (drives managed-store cost; ScaNN tuning is the service's job) ---- */
    const chunks = (i.corpusSize || 0) * K.chunksPerDoc;
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
    }
    m.storageMo = m.indexGB * K.storageGCS + (m.tokensDay / 1e6 * 0.001 * 30);
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
    if (arch.purpose === 'assistant' && arch.effLatency === 'subsecond' && !arch.caching.autocomplete && (m.cacheHitEff || 0) < 0.3) add('caching', 'Sub-second p95 depends on cache hits - enable query autocomplete plus exact or semantic cache so the popular head returns without full inference.', 'latency down', 'autocomplete');
    return out;
  }

  /* The single BoM gating source: every component name this design provisions.
     Both the BoM chip list and the priced cost lines consume this. */
  function components(arch, inputs) {
    const a = arch, i = inputs, b = new Set();
    if (a.agent.gke) b.add('GKE Autopilot (agent)');
    else b.add(a.agent.platform === 'adk' ? 'ADK + Agent Runtime' : a.agent.platform === 'studio' ? 'Agent Studio' : 'LangGraph');
    if (a.agent.platform === 'langgraph') { b.add('LangGraph'); b.add('Self-managed infra + ops (LangGraph)'); b.add('LangGraph Platform Enterprise (self-host license)'); }
    if (a.gov.gateway) { b.add('Cloud IAP'); if (!a.topology.privateOnly) { b.add('Cloud API Gateway'); b.add('Apigee'); } }
    if (a.gov.auditLog) b.add('Cloud Logging (WORM)');
    if (a.retrieval.storeDrawn && a.retrieval.ragEngine === 'vais') {
      b.add('Agent Search');
    } else if (a.retrieval.storeDrawn) {
      b.add(a.retrieval.vectorDB === 'vertex' ? 'Vector Search' : 'AlloyDB');
      if (a.retrieval.mode === 'hybrid' || a.retrieval.mode === 'rerank') b.add('BM25');
      if (a.retrieval.ingestionSep || i.dataSources.includes('website')) b.add('Dataflow');
      if (i.dataSources.includes('doc_corpus') || i.dataSources.includes('website')) b.add('Document AI');
    }
    if (i.dataSources.includes('bigquery')) b.add('BigQuery');
    b.add(a.state.store.includes('spanner') ? 'Spanner' : a.state.store.includes('alloydb') ? 'AlloyDB (state)' : a.state.store === 'redis' ? 'Memorystore Cluster' : 'Cloud SQL');
    /* Managed Memorystore: the Redis hot tier when it is not self-hosted on GKE,
       and the managed response cache. Self-hosted Redis rides the GKE line. */
    if ((a.state.redisTier && !a.state.redisSelf) || (a.caching.responseCacheOn && !a.agent.gke)) b.add('Memorystore Cluster');
    b.add('Cloud Trace'); b.add('Agent Platform Evals');
    if (a.gov.guardrails) b.add('Model Armor');
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
    [a.models.reasoningModel, a.models.fastModel].forEach(id => b.add(C().modelById(id).name));
    return [...b];
  }

  /* Estimated monthly $ for a BoM component, 0 if bundled/free, null if not modeled. */
  function priceComponent(name, m, inputs) {
    const K = C().K, i = inputs;
    const R = i.actors * i.actionsPerDay * 30.4;
    const Tk = m.tokensDay * 30.4;
    const idxNodes = m.indexGB > 0 ? Math.max(1, Math.ceil(m.indexGB / 50)) : 0;
    const dbNodes = Math.max(1, Math.ceil((m.volPeak || 0) / 100));
    const docsDay = Math.round((i.corpusSize || 0) * K.ingestion.docsPerDayFactor);
    const pages = K.ingestion.docPages;
    const bqScanTiB = (R * K.bqScanMB) / 1048576;
    const P = {
      'ADK + Agent Runtime': 40 + R * 0.0006,
      'Agent Studio': 40 + R * 0.0006,
      'LangGraph': 0,
      'Self-managed infra + ops (LangGraph)': 850 + dbNodes * 150 + R * 0.0004,
      'LangGraph Platform Enterprise (self-host license)': 5000,
      'Apigee': 120 + R * 0.0003,
      'Cloud IAP': 0,
      'Cloud API Gateway': 3 + R * 0.000003,
      'Cloud Logging (WORM)': 5 + (Tk / 1e6) * 0.05,
      'Cloud Audit Logs (Data Access)': 5 + (R / 1e6) * 10,
      'Vector Search': idxNodes * 438,
      'Agent Search': R * K.vais.perQuery + (m.indexGB || 0) * K.vais.storageGiB + (i.dataSources.includes('website') ? K.vais.websiteBase : 0),
      'AlloyDB': 300 + m.indexGB * 0.3,
      'AlloyDB (state)': 280 + dbNodes * 110 + m.indexGB * 0.3,
      'BM25': 0,
      'Dataflow': docsDay > 0 ? 30 + docsDay * 0.02 : 0,
      'Document AI': docsDay * pages * 30.4 * 0.0015,
      'BigQuery': Math.max(0, bqScanTiB - 1) * K.bqOnDemandPerTiB + Math.max(0, K.bqStorageGB - 10) * K.storageBQ,
      'Spanner': dbNodes * 657 + m.indexGB * 0.3,
      'Cloud SQL': 200 + dbNodes * 120,
      'Memorystore Cluster': 70,
      'GKE Autopilot (agent)': 140 + dbNodes * 20,
      'Cloud Storage': 5 + (m.indexGB || 0) * 0.02,
      'Secret Manager': 1,
      'Cloud KMS': 3 + (R / 1e6) * 0.03,
      'Pub/Sub': 10 + (R / 1e6) * 0.4,
      'Cloud Trace': (R / 1e6) * 2.0,
      'Agent Platform Evals': (R * 0.05 / 1000) * 0.5,
      'Model Armor': (R / 1000) * 0.5,
      'Workload Identity': 0,
      'Model Registry': 0,
      'VPC Service Controls': 0,
      'Cloud DLP': (Tk / 1e6) * 1.0,
      'IAM': 0,
      'vLLM on GKE': 73,
    };
    return (name in P) ? P[name] : null;
  }

  const unpricedReason = () => ({ short: 'usage not modeled', why: 'Spend is usage-dependent and not modeled here, so this line is shown as not modeled.' });

  /* Splits the BoM into priced / unpriced / free, sums platform $, and returns the
     combined monthly run-rate. */
  function costSummary(arch, m, inputs) {
    const cat = C();
    const genai = (m.costOpt || 0) + (m.gpuMo || 0);
    const models = new Set([cat.modelById(arch.models.reasoningModel).name, cat.modelById(arch.models.fastModel).name]);
    const comps = components(arch, inputs).filter(n => !models.has(n));
    const priced = [], red = [], free = [];
    comps.forEach(name => {
      const est = priceComponent(name, m, inputs);
      if (est == null) red.push({ name, ...unpricedReason() });
      else if (est === 0 && name !== 'LangGraph') free.push(name);
      else priced.push({ name, mo: est });
    });
    const platMo = priced.reduce((s, x) => s + x.mo, 0);
    return { genai, priced, red, free, platMo, totalMo: genai + platMo };
  }

  NS.metrics = { compute, lint, components, priceComponent, costSummary };
})(typeof window !== 'undefined' ? (window.ASD2 = window.ASD2 || {}) : (globalThis.ASD2 = globalThis.ASD2 || {}));
