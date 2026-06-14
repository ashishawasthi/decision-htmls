/* Agentic System Designer v2 - self-test.
   Runs in the browser with ?test (results into #testbar and the console) and in
   node (node -e "require('./asd2-selftest.js'); console.log(globalThis.ASD2.selfTest.run())"
   after requiring the other modules). DOM-free: every check runs against the pure
   pipeline, which is the point - derive, metrics, and the diagram are functions
   of (purpose, inputs, overrides) and nothing else. */
(function (NS) {
  'use strict';

  /* Full fingerprint of everything the right panel would show for a config. */
  function fp(purpose, inputs, overrides) {
    const r = NS.derive(purpose, inputs, overrides || {});
    const m = NS.metrics.compute(r.arch, inputs);
    const cs = NS.metrics.costSummary(r.arch, m, inputs);
    const comps = NS.metrics.components(r.arch, inputs);
    const dg = NS.diagram.buildDiagram(r.arch, { dir: 'LR', theme: 'dark' });
    return JSON.stringify({ d: r.decisions, a: r.arch, m, cs, comps, dg, lint: r.lint.concat(NS.metrics.lint(r.arch, m, inputs)) });
  }
  const clone = o => JSON.parse(JSON.stringify(o));
  const deepFreeze = o => { Object.values(o).forEach(v => { if (v && typeof v === 'object') deepFreeze(v); }); return Object.freeze(o); };

  function run() {
    const P = NS.presets.PRESETS;
    const results = [];
    const assert = (n, c) => results.push([n, !!c]);
    const pipe = (pur, inputs, ov) => {
      const r = NS.derive(pur, inputs, ov || {});
      const m = NS.metrics.compute(r.arch, inputs);
      return { r, m, arch: r.arch, dv: k => r.decisions[k].value, lint: r.lint.concat(NS.metrics.lint(r.arch, m, inputs)), dg: NS.diagram.buildDiagram(r.arch, { dir: 'LR', theme: 'dark' }), cs: NS.metrics.costSummary(r.arch, m, inputs), comps: NS.metrics.components(r.arch, inputs) };
    };
    const vpcBlock = d => {
      const start = d.indexOf('subgraph VPC[');
      if (start < 0) return '';
      const out = []; let depth = 0;
      for (const ln of d.slice(start).split('\n')) {
        out.push(ln);
        if (/^\s*subgraph /.test(ln)) depth++;
        else if (/^\s*end\s*$/.test(ln)) { depth--; if (depth === 0) break; }
      }
      return out.join('\n');
    };

    /* ---- 1. determinism and purity ---- */
    let allDet = true, allPure = true;
    for (const [pur, group] of Object.entries(P)) {
      for (const p of Object.values(group)) {
        const frozen = deepFreeze(clone(p.inputs));
        try {
          if (fp(pur, frozen, deepFreeze({})) !== fp(pur, frozen, deepFreeze({}))) allDet = false;
        } catch (e) { allPure = false; }
      }
    }
    const presetCount = Object.values(P).reduce((n, g) => n + Object.keys(g).length, 0);
    assert(`derive/metrics/diagram are deterministic for all ${presetCount} presets`, allDet);
    assert('the pipeline never mutates frozen inputs or overrides', allPure);

    /* ---- 2. revert round-trips: the bug class this rewrite exists to kill ---- */
    const roundTrip = (pur, preset, key, to) => {
      const base = clone(P[pur][preset].inputs);
      const before = fp(pur, base, {});
      const mutated = clone(base); mutated[key] = to;
      fp(pur, mutated, {});                       /* visit the mutated state */
      return fp(pur, clone(base), {}) === before; /* reverting reverts everything */
    };
    assert('revert: latency agentic -> subsecond -> agentic restores all outputs', roundTrip('assistant', 'expert_copilot', 'latencyPreset', 'subsecond'));
    assert('revert: freshness eod -> realtime -> eod restores all outputs', roundTrip('assistant', 'expert_copilot', 'freshness', 'realtime'));
    assert('revert: audience regulated -> internal_low -> regulated restores all outputs', roundTrip('assistant', 'expert_copilot', 'audienceSensitivity', 'internal_low'));
    assert('revert: deployment gcp -> hybrid -> gcp restores all outputs', roundTrip('assistant', 'expert_copilot', 'deployment', 'hybrid'));
    assert('revert: opsModel managed -> self_managed -> managed restores all outputs', roundTrip('assistant', 'expert_copilot', 'opsModel', 'self_managed'));
    assert('revert: each data source add -> remove restores all outputs', ['web', 'stream', 'kg', 'website'].every(src => {
      const base = clone(P.assistant.expert_copilot.inputs);
      const before = fp('assistant', base, {});
      const mutated = clone(base); mutated.dataSources = base.dataSources.concat([src]);
      fp('assistant', mutated, {});
      return fp('assistant', clone(base), {}) === before;
    }));
    assert('revert: a pin set then removed restores all outputs', (() => {
      const base = clone(P.assistant.expert_copilot.inputs);
      const before = fp('assistant', base, {});
      fp('assistant', base, { stateStore: 'spanner', routingSplit: 30 });
      return fp('assistant', base, {}) === before;
    })());
    assert('revert: multiRegion pin on -> off restores the state store', (() => {
      const base = clone(P.automation.internal_lowstakes.inputs); base.opsModel = 'self_managed';
      const on = pipe('automation', base, { multiRegion: true });
      const off = pipe('automation', base, {});
      return on.dv('stateStore') === 'redis_spanner' && off.dv('stateStore') === 'redis';
    })());

    /* ---- 3. presets only set inputs; derived posture matches the original ---- */
    assert('every preset is a pure input bundle (no override keys)', Object.values(P).every(g => Object.values(g).every(p => !('overrides' in p) && p.inputs && typeof p.inputs === 'object')));
    {
      const x = pipe('assistant', P.assistant.self_managed.inputs);
      assert('Self-Managed derives GKE + self-built RAG + Redis cache + Secret Manager', x.dv('agentRuntime') === 'gke' && x.dv('ragEngine') === 'selfbuilt' && x.arch.caching.responseCacheOn && x.arch.security.secretManagerOn);
      assert('Self-Managed ships CMEK + VPC-SC from its regulated tier', x.dv('cmek') === true && x.dv('enforceVpcSc') === true);
    }
    {
      const x = pipe('assistant', P.assistant.enterprise_search.inputs);
      assert('sub-second derives the no-agent path: Agent Search answers directly', x.dv('pattern') === 'none' && x.arch.agent.answerOnly === true && x.dv('ragEngine') === 'vais');
      assert('enterprise search derives response caching on', x.arch.caching.responseCacheOn);
      assert('enterprise search stays within the sub-second budget', x.m.latencyOverBudget === false && x.m.latencyP95 < 1000);
      assert('enterprise search derives Agent Search + separated ingestion over the drawn store', x.dv('ingestionSep') === true && x.arch.retrieval.storeDrawn === true);
      assert('no-agent diagram: no agent box, model leg, or state store; the request lands on the store', !/subgraph AE/.test(x.dg) && !/Generator/.test(x.dg) && !/LLM\[/.test(x.dg) && !/Armor/.test(x.dg) && !/State\[\(/.test(x.dg) && /Cache -- miss --> Store/.test(x.dg) && x.dg.includes('Store -. query logs + traces .-> Obs'));
      assert('no-agent BoM: no runtime, models, state store, or Model Armor; Agent Search present', !x.comps.includes('ADK + Agent Runtime') && !x.comps.some(n => /Gemini|Claude|Llama/.test(n)) && !x.comps.includes('AlloyDB (state)') && !x.comps.includes('Model Armor') && x.comps.includes('Agent Search'));
      assert('no-agent GenAI cost zeroes out; Agent Search queries carry the spend', x.m.costOpt === 0 && x.cs.genai === 0 && x.cs.priced.some(c => c.name === 'Agent Search' && c.mo > 0));
      assert('no-agent capacity: zero model calls, no instance sizing, no PT need', x.arch.agent.modelCallsPerReq === 0 && x.m.qpsModelPeak === 0 && x.m.agentInstances === null && x.m.needsProvisionedThroughput === false);
      assert('the bundled answer streams: first token = full minus the answer tail, not the request tokensOut', x.m.latParts.some(p => /Agent Search answer/.test(p.label) && p.stream > 0) && x.m.latencyStartP95 > 0 && Math.abs(x.m.latencyP95 - x.m.latencyStartP95 - NS.catalog.K.lat.vaisAnswerTok * NS.catalog.modelById('gemini-31-flash-lite').msPerOutTok) < 0.5);
      const ss = clone(P.assistant.expert_copilot.inputs); ss.latencyPreset = 'subsecond';
      const nx = pipe('assistant', ss);
      assert('no-agent path flags selected live sources as ignored, keeps the indexed corpus', nx.arch.retrieval.ignoredSources.includes('alloydb_oltp') && !nx.arch.retrieval.ignoredSources.includes('doc_corpus') && !/Live data/.test(nx.dg));
      assert('every other tier uses all selected sources (nothing flagged ignored)', pipe('assistant', P.assistant.expert_copilot.inputs).arch.retrieval.ignoredSources.length === 0 && pipe('assistant', Object.assign(clone(P.assistant.expert_copilot.inputs), { latencyPreset: 'interactive' })).arch.retrieval.ignoredSources.length === 0);
      assert('retrieval pinned off flags the indexed source as ignored too', pipe('assistant', P.assistant.expert_copilot.inputs, { retrieval: 'none' }).arch.retrieval.ignoredSources.includes('doc_corpus'));
    }
    {
      const x = pipe('assistant', P.assistant.conversational_analytics.inputs);
      assert('conversational analytics derives no retrieval and no store (BigQuery is live)', x.dv('retrieval') === 'none' && x.arch.retrieval.ragOn === false && x.arch.retrieval.storeDrawn === false && x.arch.retrieval.liveSel.includes('bigquery'));
      assert('conversational analytics derives the multi-agent team + context cache, response cache off', x.dv('pattern') === 'multi' && x.arch.caching.contextCache === true && x.arch.caching.responseCacheOn === false);
    }
    {
      const x = pipe('assistant', P.assistant.strictpii_verify.inputs);
      assert('grounding-only preset derives retrieval off, no phantom store', x.dv('retrieval') === 'none' && !/Agent Search/.test(x.dg) && /Web grounding/.test(x.dg) && !x.comps.includes('Agent Search'));
      assert('strict-PII derives sandbox + residency + guardrails', x.arch.gov.sandbox === true && x.arch.gov.residencyPin === true && x.arch.gov.guardrails === true);
    }
    {
      const low = pipe('automation', P.automation.internal_lowstakes.inputs);
      assert('low-stakes automation: light governance, action controls on', low.arch.gov.gateway === false && low.arch.gov.guardrails === false && low.arch.gov.sandbox === false && low.arch.gov.rulesEngine === true && low.arch.gov.toolAuthz === true && low.arch.gov.hitlApproval === 'maker_checker');
      assert('low-stakes automation leaves CMEK + VPC-SC off', low.dv('cmek') === false && low.dv('enforceVpcSc') === false);
      assert('managed automation uses Agent Runtime sessions + per-run minutes', low.dv('stateStore') === 'managed' && low.arch.effLatency === 'minutes');
      const sp = pipe('automation', P.automation.strictpii.inputs);
      assert('strict-PII automation mandates sandbox + gateway + residency + dual control', sp.arch.gov.sandbox === true && sp.arch.gov.gateway === true && sp.arch.gov.residencyPin === true && sp.arch.gov.hitlApproval === 'dual');
      assert('the sandbox is dispatched by the Orchestrator, not the Generator', /Orchestrator --> Sand/.test(sp.dg) && !/Generator --> Sand/.test(sp.dg));
    }

    /* ---- 4. domain invariants on the diagram and BoM ---- */
    {
      const x = pipe('assistant', P.assistant.expert_copilot.inputs);
      assert('managed Agent Runtime keeps no BYO state store - managed Sessions instead', !/subgraph VPC\[/.test(x.dg) && !/AE -- state/.test(x.dg) && /AE -- session \+ memory state --> Sessions/.test(x.dg) && !x.comps.includes('AlloyDB (state)'));
      assert('fully managed design has no Secret Manager (diagram or BoM)', !/SecretMgr/.test(x.dg) && !x.comps.includes('Secret Manager'));
      assert('regulated tier draws the perimeter and lists VPC Service Controls', /subgraph PERIM/.test(x.dg) && x.comps.includes('VPC Service Controls'));
      assert('CMEK edges reach managed stores only', /KMS -\. encrypts \.-> GCS/.test(x.dg) && !/KMS -\. encrypts \.-> Cache/.test(x.dg) && !/KMS -\. encrypts \.-> State\b/.test(x.dg));
      assert('Data Access audit edges mirror the CMEK target set', x.arch.security.auditTargets.join() === x.arch.security.kmsTargets.join() && /-\. data access \.-> Audit/.test(x.dg));
      assert('multi-agent routes every hand-off through the Orchestrator (no point-to-point links, no drawn responses)', /Orchestrator --> Generator/.test(x.dg) && /Orchestrator --> Validator/.test(x.dg) && !/Generator --> Validator/.test(x.dg) && !/revise/.test(x.dg) && !/Generator --> Orchestrator/.test(x.dg) && !/Retriever --> Orchestrator/.test(x.dg));
      assert('multi-agent data tools hang off the Retrieval agent, never the Generator', /Orchestrator --> Retriever/.test(x.dg) && /Retriever -- MCP tool-call · read-only --> Live/.test(x.dg) && !/Generator --> Store/.test(x.dg) && !/Generator --> Live/.test(x.dg) && !/Generator --> WebG/.test(x.dg));
      assert('managed Agent Search folds retrieval into the store (de-identify before import at this tier)', !/Retrieval funnel/.test(x.dg) && /Retriever --> Store/.test(x.dg) && /Idx -\. de-identify \.-> DLPDeid/.test(x.dg) && /DLPDeid -\. import \+ parse \+ embed \.-> Store/.test(x.dg));
      assert('no HNSW or Elastic anywhere in diagram or BoM', !/HNSW|Elastic/i.test(x.dg) && !x.comps.some(c => /HNSW|Elastic/i.test(c)));
    }
    {
      const x = pipe('assistant', P.assistant.self_managed.inputs);
      const vb = vpcBlock(x.dg);
      assert('self-managed: GKE agent box and Redis tier inside the VPC', /subgraph AE/.test(vb) && /State\[\(/.test(vb) && /Cache\[\(/.test(vb));
      assert('self-managed: managed ScaNN store outside the VPC over PSC, Redis-only state (no durable tier)', !/Store\[\(/.test(vb) && /Retr -- PSC --> Store/.test(x.dg) && !/StateDur/.test(x.dg));
      assert('self-managed: the Retrieval agent fronts the in-VPC funnel', /Retriever --> Retr/.test(x.dg) && !/Generator --> Retr/.test(x.dg));
      assert('self-managed: SecretMgr drawn for the Redis AUTH and listed in the BoM', /AE -\. Redis AUTH \.-> SecretMgr/.test(x.dg) && x.comps.includes('Secret Manager'));
      assert('self-managed: CMEK covers the managed store but never in-VPC Redis', /KMS -\. encrypts \.-> Store/.test(x.dg) && !/KMS -\. encrypts \.-> State\b/.test(x.dg) && !/KMS -\. encrypts \.-> Cache/.test(x.dg));
      assert('self-managed: no Memorystore line (Redis rides the GKE line)', !x.comps.includes('Memorystore Cluster') && x.comps.includes('GKE Autopilot (agent)'));
    }
    {
      const smBase = clone(P.automation.internal_lowstakes.inputs); smBase.opsModel = 'self_managed';
      const sm = pipe('automation', smBase);
      assert('self-managed automation = Redis-only state with the persistence caveat lint', sm.dv('stateStore') === 'redis' && sm.arch.state.drawn === true && !/StateDur/.test(sm.dg) && sm.lint.some(l => l.src === 'stateStore' && /write-loss window/.test(l.msg)));
      const mmr = pipe('assistant', P.assistant.expert_copilot.inputs, { multiRegion: true });
      assert('managed + multi-region warns that Agent Runtime Sessions are regional', mmr.lint.some(l => l.src === 'multiRegion' && /regional/.test(l.msg)));
      const mgd = pipe('assistant', P.assistant.expert_copilot.inputs);
      assert('managed assistant: no BYO state store, Sessions node drawn', mgd.arch.state.drawn === false && mgd.arch.state.managedSessions === true && /Agent Runtime sessions/.test(mgd.dg) && !mgd.comps.includes('AlloyDB (state)'));
    }
    {
      const hy = clone(P.assistant.expert_copilot.inputs); hy.deployment = 'hybrid'; hy.dataSources = ['doc_corpus'];
      const x = pipe('assistant', hy);
      assert('hybrid: private-only ingress (no Client UI / EdgeGW / Apigee / API Gateway)', !/Client UI/.test(x.dg) && !/EdgeGW/.test(x.dg) && !x.comps.includes('Apigee') && !x.comps.includes('Cloud API Gateway'));
      assert('hybrid: IAP / mTLS hop on the interconnect into the agent', /OnpremUsers == Cloud Interconnect ==> CloudRouter/.test(x.dg) && /CloudRouter -- IAP \/ mTLS --> Orchestrator/.test(x.dg));
      assert('hybrid: dedicated VPC derives on for the Cloud Router', x.dv('dedicatedVpc') === true && /subgraph VPC\[/.test(x.dg));
      assert('hybrid: latency swaps the gateway hop for a 3ms IAP check', x.m.latParts.some(p => p.label === 'IAP / mTLS' && p.ms === 3) && !x.m.latParts.some(p => p.label === 'API Gateway'));
      assert('hybrid: BoM keeps Cloud IAP', x.comps.includes('Cloud IAP'));
      const gcp = pipe('assistant', P.assistant.expert_copilot.inputs);
      assert('gcp keeps the public door and gateway SKUs (no regression)', /Client UI/.test(gcp.dg) && gcp.comps.includes('Apigee') && gcp.comps.includes('Cloud API Gateway') && !/ONPREM/.test(gcp.dg));
    }
    {
      const it = clone(P.assistant.expert_copilot.inputs); it.latencyPreset = 'interactive';
      const x = pipe('assistant', it);
      assert('interactive SLO derives the single streaming agent (not the team, not no-agent)', x.dv('pattern') === 'single' && x.arch.agent.answerOnly === false);
      assert('single-agent box holds the Generator only, tools stay on the Generator', /Generator\[/.test(x.dg) && !/Orchestrator/.test(x.dg) && !/Validator/.test(x.dg) && !/Retriever/.test(x.dg) && /Generator --> Store/.test(x.dg));
      assert('interactive budgets (2s start / 5s full) fit the single agent with grounding', x.m.latencyStartBudget === 2000 && x.m.latencyBudget === 5000 && !x.m.latencyStartOverBudget && !x.m.latencyOverBudget);
      assert('multi-agent pinned at interactive busts the 5s budget', pipe('assistant', it, { pattern: 'multi' }).m.latencyOverBudget === true);
    }

    /* ---- 5. pins conflict via lint, never via silent rewrite ---- */
    {
      const base = clone(P.automation.internal_lowstakes.inputs);
      const x = pipe('automation', base, { multiRegion: true, stateStore: 'alloydb' });
      assert('pinned conflict keeps the pinned value and raises a lint', x.dv('stateStore') === 'alloydb' && x.lint.some(l => l.src === 'stateStore' && l.sev === 'conflict'));
    }
    {
      const hy = clone(P.assistant.expert_copilot.inputs); hy.deployment = 'hybrid';
      const x = pipe('assistant', hy, { dedicatedVpc: false });
      assert('hybrid with the VPC pinned off lints instead of forcing it', x.dv('dedicatedVpc') === false && x.lint.some(l => l.src === 'dedicatedVpc'));
    }
    {
      const x = pipe('assistant', P.assistant.expert_copilot.inputs, { reasoningModel: 'llama4-selfhost', agentRuntime: 'agentengine' });
      assert('self-host model pinned onto the managed runtime lints', x.lint.some(l => l.src === 'agentRuntime'));
    }
    {
      const sub = clone(P.assistant.enterprise_search.inputs);
      const x = pipe('assistant', sub, { pattern: 'multi' });
      assert('multi-agent pinned at sub-second lints, value stays pinned', x.dv('pattern') === 'multi' && x.lint.some(l => l.src === 'pattern'));
    }
    {
      const rt = clone(P.assistant.expert_copilot.inputs); rt.freshness = 'realtime';
      const x = pipe('assistant', rt, { exactCache: true });
      assert('cache pinned on against realtime freshness lints', x.lint.some(l => l.src === 'exactCache'));
      assert('realtime without a streaming source suggests adding one', x.lint.some(l => l.src === 'freshness'));
    }
    {
      const sub = clone(P.assistant.enterprise_search.inputs); sub.dataSources = ['doc_corpus', 'bigquery'];
      const x = pipe('assistant', sub);
      assert('a live source at sub-second conflicts (no agent to query it); latency stays in budget', x.m.latencyOverBudget === false && x.lint.some(l => l.sev === 'conflict' && /answers only from its index/.test(l.msg)) && !/Live data/.test(x.dg));
      const noIdx = clone(P.assistant.enterprise_search.inputs); noIdx.dataSources = ['bigquery']; noIdx.corpusSize = 0;
      assert('sub-second with no indexed source conflicts (nothing to answer from)', pipe('assistant', noIdx).lint.some(l => l.sev === 'conflict' && /no indexed source/.test(l.msg)));
      assert('a self-built pipeline pinned at sub-second conflicts', pipe('assistant', P.assistant.enterprise_search.inputs, { ragEngine: 'selfbuilt' }).lint.some(l => l.src === 'ragEngine' && l.sev === 'conflict'));
      const sh = clone(P.assistant.enterprise_search.inputs); sh.modelStrategy = 'self_host';
      const shx = pipe('assistant', sh);
      assert('self-host models at sub-second conflict and provision no fleet', shx.lint.some(l => l.src === 'modelStrategy' && l.sev === 'conflict') && !shx.arch.models.selfHostAny && !shx.m.gpuNodes && !shx.comps.includes('vLLM on GKE'));
    }

    /* ---- 6. metrics and cost sanity (ported from the original self-test) ---- */
    {
      const x = pipe('assistant', P.assistant.expert_copilot.inputs);
      assert('optimized cost never exceeds the naive baseline', x.m.costOpt <= x.m.costNaive);
      assert('peak volume is at least the average', x.m.volPeak >= x.m.volAvg);
      assert('latency parts sum to the p95 total', Math.abs(x.m.latParts.reduce((s, p) => s + p.ms, 0) - x.m.latencyP95) < 1 && x.m.latParts.length > 0);
      assert('platform cost adds to GenAI in the run-rate', x.cs.platMo > 0 && Math.abs(x.cs.totalMo - ((x.m.costOpt || 0) + (x.m.gpuMo || 0) + x.cs.platMo)) < 1e-6);
      assert('BigQuery is volume-modeled', pipe('assistant', P.assistant.conversational_analytics.inputs).cs.priced.some(c => c.name === 'BigQuery'));
    }
    {
      const base = clone(P.assistant.expert_copilot.inputs);
      const k0 = pipe('assistant', base, { reuseInputPct: 0 }).m.costOpt;
      const k1 = pipe('assistant', base, { reuseInputPct: 80 }).m.costOpt;
      assert('higher context-cache reuse lowers cost', k1 < k0);
      const w0 = pipe('assistant', base).m.costParts.grounding;
      const webbed = clone(base); webbed.dataSources = base.dataSources.concat(['web']);
      const w1 = pipe('assistant', webbed).m.costParts.grounding;
      assert('live web grounding adds a per-search cost', w0 === 0 && w1 > 0);
      const g1 = clone(base); g1.dataSources = ['doc_corpus', 'bigquery'];
      const g2 = clone(base); g2.dataSources = ['doc_corpus', 'bigquery', 'web'];
      const groundMs = x => (x.m.latParts.find(p => p.label === 'Grounding') || {}).ms;
      assert('parallel grounding takes the max, not the sum', groundMs(pipe('assistant', g1)) === groundMs(pipe('assistant', g2)));
    }
    {
      const big = Object.assign(clone(P.automation.internal_lowstakes.inputs), { actors: 50000, actionsPerDay: 60, tokensOut: 2000, modelStrategy: 'self_host' });
      const nbf = pipe('automation', big, { quant: 'bf16' }).m.gpuNodes;
      const ni4 = pipe('automation', big, { quant: 'int4' }).m.gpuNodes;
      assert('int4 fleet smaller than bf16 fleet at multi-node volume', nbf > 1 && ni4 < nbf);
      assert('all-self-host zeroes the token cost', pipe('automation', big).m.costOpt === 0);
      const nMix = pipe('automation', big, { quant: 'bf16', reasoningModel: 'gemini-35-flash' });
      assert('mixed self-host bills both the managed API and a GPU fleet', !nMix.arch.models.selfHostAll && nMix.m.costOpt > 0 && nMix.m.gpuMo > 0 && nMix.m.gpuNodes < nbf);
      const nUn = pipe('automation', big, { quant: 'bf16', reasoningModel: 'gemini-35-flash', smartRouting: false }).m.gpuNodes;
      assert('a self-host model routing never reaches falls to the 1-node floor', nUn === 1);
    }
    {
      const base = clone(P.assistant.expert_copilot.inputs);
      const latFL = pipe('assistant', base).m.latencyP95;
      const latSlow = pipe('assistant', base, { fastModel: 'claude-opus-48' }).m.latencyP95;
      const latNoRoute = pipe('assistant', base, { smartRouting: false }).m.latencyP95;
      assert('a slower fast model raises p95; routing lowers it vs all-reasoning', latSlow > latFL && latFL < latNoRoute);
    }
    {
      const x = pipe('assistant', P.assistant.expert_copilot.inputs, { platform: 'langgraph' });
      const adk = pipe('assistant', P.assistant.expert_copilot.inputs);
      assert('LangGraph surfaces self-managed infra + the enterprise license as cost lines', x.comps.includes('Self-managed infra + ops (LangGraph)') && x.comps.includes('LangGraph Platform Enterprise (self-host license)') && !adk.comps.includes('Self-managed infra + ops (LangGraph)'));
      assert('LangGraph self-host TCO exceeds the managed runtime at default scale', x.cs.platMo > adk.cs.platMo);
    }

    /* ---- 6b. cost justification: calc strings, refs, and the new cost lines ---- */
    {
      const base = P.assistant.expert_copilot.inputs;
      const x = pipe('assistant', base);
      const bq = NS.metrics.priceComponent('BigQuery', x.m, base);
      assert('priceComponent returns { mo, calc } for a priced component', !!bq && isFinite(bq.mo) && typeof bq.calc === 'string' && /\d/.test(bq.calc));
      assert('priceComponent returns null for an unknown component', NS.metrics.priceComponent('NopeXYZ', x.m, base) === null);
      const allPresets = Object.entries(P).flatMap(([pur, g]) => Object.values(g).map(p => pipe(pur, p.inputs)));
      assert('every priced row carries a substituted calc string (all presets)', allPresets.every(t => t.cs.priced.every(c => typeof c.calc === 'string' && /\d/.test(c.calc))));
      const hyIn = clone(base); hyIn.deployment = 'hybrid';
      const covered = allPresets.concat([pipe('assistant', hyIn), pipe('assistant', base, { platform: 'langgraph' })]);
      const modelNames = new Set(NS.catalog.MODELS.map(mm => mm.name));
      assert('every BoM component has a PRICE book entry (no silent red rows)', covered.every(t => t.comps.every(n => modelNames.has(n) || n in NS.catalog.PRICE)));
      assert('GenAI calc strings cover fresh, output, and the naive baseline', ['fresh', 'output', 'naive'].every(k => x.m.costCalc[k] && /\d/.test(x.m.costCalc[k])));
      const big = Object.assign(clone(P.automation.internal_lowstakes.inputs), { actors: 50000, actionsPerDay: 60, tokensOut: 2000, modelStrategy: 'self_host' });
      assert('self-host fleet carries a GPU calc string', /\d.*node/.test(pipe('automation', big).m.costCalc.gpu));
    }
    {
      const hyIn = clone(P.assistant.expert_copilot.inputs); hyIn.deployment = 'hybrid';
      const hy = pipe('assistant', hyIn), gcp = pipe('assistant', P.assistant.expert_copilot.inputs);
      assert('hybrid bills the interconnect and lists the BoM chip', hy.comps.includes('Cloud Interconnect + VLAN') && hy.cs.priced.some(c => c.name === 'Cloud Interconnect + VLAN' && c.mo > 100));
      assert('gcp deployment has no interconnect line', !gcp.comps.includes('Cloud Interconnect + VLAN'));
      assert('internal audience on gcp has no internet egress line', !gcp.cs.priced.some(c => c.name === 'Network egress (internet)'));
      const ext = pipe('assistant', P.assistant.customer_support.inputs);
      assert('external audience on gcp adds a small internet egress line', ext.cs.priced.some(c => c.name === 'Network egress (internet)' && c.mo > 0 && c.mo < 50));
      assert('hybrid never bills internet egress (private-only ingress)', !hy.cs.priced.some(c => c.name === 'Network egress (internet)'));
    }
    {
      const man = pipe('assistant', P.assistant.expert_copilot.inputs);
      const slf = pipe('assistant', P.assistant.self_managed.inputs);
      assert('below the line reconciles and never enters the run-rate', Math.abs(man.cs.btlMo - man.cs.btl.reduce((s, x) => s + x.mo, 0)) < 1e-6 && Math.abs(man.cs.totalMo - (man.cs.genai + man.cs.platMo)) < 1e-6);
      assert('fully managed design carries support but no ops labor below the line', man.cs.btl.length === 1 && man.cs.btl[0].name === 'Enterprise support (Enhanced)' && NS.metrics.laborLines(man.arch, man.m).length === 0);
      assert('self-managed design adds an ops labor line below the line', slf.cs.btl.some(b => b.name.indexOf('Ops & on-call labor') === 0) && slf.cs.btlMo > man.cs.btlMo);
      const lr = NS.catalog.PRICE['Ops & on-call labor (build vs buy)'].rates;
      const big = Object.assign(clone(P.automation.internal_lowstakes.inputs), { actors: 50000, actionsPerDay: 60, tokensOut: 2000, modelStrategy: 'self_host' });
      const sh = pipe('automation', big);
      const shLabor = NS.metrics.laborLines(sh.arch, sh.m)[0];
      assert('a self-host fleet prices labor at no less than the FTE floor', !!shLabor && shLabor.mo >= lr.gpuMinFte * lr.ftePerMo);
      assert('support is the greater of the minimum or the tiered percentage', man.cs.btl[man.cs.btl.length - 1].mo >= NS.catalog.PRICE['Enterprise support (Enhanced)'].rates.minMo);
    }
    {
      const man = pipe('assistant', P.assistant.expert_copilot.inputs);
      const slf = pipe('assistant', P.assistant.self_managed.inputs);
      assert('self-built pipeline prices embedding ingestion; Agent Search bundles it', slf.cs.priced.some(c => c.name === 'Embeddings (ingestion)' && c.mo > 0) && !man.comps.includes('Embeddings (ingestion)'));
      const nc = clone(P.assistant.self_managed.inputs); nc.corpusSize = 0;
      assert('no corpus, no embedding line', !pipe('assistant', nc).comps.includes('Embeddings (ingestion)'));
      const dlp = man.cs.priced.find(c => c.name === 'Cloud DLP');
      assert('DLP prices per GB inspected, not per token (the old rate gave ~$1,459 here)', !!dlp && dlp.mo > 0 && dlp.mo < 100);
      assert('cost per 1k requests reconciles with the run-rate', Math.abs(man.cs.perK - man.cs.totalMo / man.m.reqMo * 1000) < 1e-9);
    }

    /* ---- 6c. Terraform generator: emission gates mirror the design, and the
       placeholder/steps data covers the bundle (no form, no drift) ---- */
    if (NS.tfgen) {
      const tg = (pur, inputs, ov) => {
        const r = NS.derive(pur, inputs, ov || {});
        return { g: NS.tfgen.generate(r.arch, inputs), arch: r.arch };
      };
      const all = g => Object.values(g.files).join('\n');
      const man = tg('assistant', P.assistant.expert_copilot.inputs);
      assert('tfgen emits the core files and the ADK skeleton', ['versions.tf', 'variables.tf', 'terraform.tfvars', 'main.tf', 'outputs.tf', 'README.md', 'agent/agent.py'].every(k => k in man.g.files));
      assert('tfgen: project_id is a required placeholder and its variable has no default', man.g.placeholders.some(p => p.var === 'project_id' && p.kind === 'required') && !/\n {2}default/.test(man.g.files['variables.tf'].match(/variable "project_id" \{[\s\S]*?\n\}/)[0]));
      assert('tfgen: README carries every step title and placeholder var', man.g.steps.every(s => man.g.files['README.md'].includes(s.title)) && man.g.placeholders.every(p => man.g.files['README.md'].includes('`' + p.var + '`')));
      assert('tfgen: managed design = Agent Runtime via adk deploy + managed Sessions, KMS, no Secret Manager, no BYO state DB', man.g.steps.some(s => s.id === 'adk-deploy') && man.g.steps.some(s => s.id === 'note-managed-sessions') && /google_kms_crypto_key/.test(man.g.files['main.tf']) && !/google_secret_manager_secret/.test(man.g.files['main.tf']) && !/google_alloydb_cluster/.test(man.g.files['main.tf']) && !/google_spanner_instance/.test(man.g.files['main.tf']));
      const hyIn = clone(P.assistant.expert_copilot.inputs); hyIn.deployment = 'hybrid';
      const hy = tg('assistant', hyIn);
      assert('tfgen hybrid: no public gateway, internal-only ingress, gated interconnect bridge + onprem tfvars', !/google_api_gateway/.test(hy.g.files['main.tf']) && /INGRESS_TRAFFIC_INTERNAL_ONLY/.test(hy.g.files['main.tf']) && /google_compute_interconnect_attachment/.test(hy.g.files['main.tf']) && hy.g.placeholders.some(p => p.var === 'onprem_interconnect' && p.kind === 'gated'));
      const slf = tg('assistant', P.assistant.self_managed.inputs);
      assert('tfgen self-managed: GKE two-phase step, Redis-on-GKE Secret Manager, ScaNN SQL step, no Elastic ever', slf.g.steps.some(s => s.id === 'two-phase-apply') && /google_secret_manager_secret/.test(slf.g.files['main.tf']) && slf.g.steps.some(s => s.id === 'scann-extension') && !/elastic/i.test(all(slf.g)) && !/elastic/i.test(all(man.g)));
      const shIn = clone(P.assistant.expert_copilot.inputs); shIn.modelStrategy = 'self_host';
      const sh = tg('assistant', shIn);
      assert('tfgen self-host: GPU pool + vLLM deploy step + gated vllm_endpoint wiring', /google_container_node_pool" "gpu/.test(sh.g.files['main.tf']) && sh.g.steps.some(s => s.id === 'vllm-deploy') && sh.g.placeholders.some(p => p.var === 'vllm_endpoint') && /VLLM_ENDPOINT/.test(sh.g.files['main.tf']));
      const low = tg('automation', P.automation.internal_lowstakes.inputs);
      assert('tfgen automation: Pub/Sub + DLQ emitted; internal-low has no KMS or perimeter', /google_pubsub_topic/.test(low.g.files['main.tf']) && /dead_letter_policy/.test(low.g.files['main.tf']) && !/google_kms/.test(low.g.files['main.tf']) && !/service_perimeter/.test(low.g.files['main.tf']) && !/google_pubsub_topic/.test(man.g.files['main.tf']));
      const es = tg('assistant', P.assistant.enterprise_search.inputs);
      assert('tfgen: site crawl target is gated on site_url and carries the verify-ownership inline note', /var\.site_url == "" \? 0 : 1/.test(es.g.files['main.tf']) && /site ownership is verified/.test(es.g.files['main.tf']) && es.g.steps.some(s => s.id === 'site-verify'));
      const ans = tg('assistant', P.assistant.enterprise_search.inputs);
      assert('tfgen no-agent: no agent code, SA, or Cloud Run; search engine + answer-api step instead', !('agent/agent.py' in ans.g.files) && !/google_service_account" "agent"/.test(ans.g.files['main.tf']) && !/google_cloud_run_v2_service" "api"/.test(ans.g.files['main.tf']) && /google_discovery_engine_search_engine/.test(ans.g.files['main.tf']) && ans.g.steps.some(s => s.id === 'answer-api') && !ans.g.placeholders.some(p => p.var === 'agent_image') && !/var\.generation_model/.test(ans.g.files['main.tf']));
      const z = NS.tfgen.zip(man.g.files);
      assert('tfgen: zip output has the PK magic and real size', z.constructor.name === 'Uint8Array' && z.length > 1000 && z[0] === 0x50 && z[1] === 0x4b);
    }

    /* ---- 6d. performance & capacity: the QPS funnel, Little's law, ceilings ---- */
    {
      const x = pipe('assistant', P.assistant.expert_copilot.inputs);
      const dft = x.m.latParts.find(p => /Generator draft/.test(p.label));
      const vd = x.m.latParts.find(p => /Validator verdict/.test(p.label));
      const rv = x.m.latParts.find(p => /Revise loop/.test(p.label));
      const pl = x.m.latParts.find(p => /Orchestrator plan/.test(p.label));
      assert('multi-agent is validator-gated: first token p95 equals the full answer, nothing streams', x.m.latencyStartIsGated === true && x.m.latencyStartP95 === x.m.latencyP95 && !x.m.latParts.some(p => p.stream > 0));
      assert('multi-agent latency = plan + full draft + verdict + p95 revise cycles', !!pl && !!dft && !!vd && !!rv && x.m.reviseCyclesP95 === 1 && Math.abs(rv.ms - x.m.reviseCyclesP95 * (dft.ms + vd.ms)) < 0.5);
      assert('revise rate 0 removes the loop; a higher rate adds p95 cycles', !pipe('assistant', P.assistant.expert_copilot.inputs, { reviseRate: 0 }).m.latParts.some(p => /Revise loop/.test(p.label)) && pipe('assistant', P.assistant.expert_copilot.inputs, { reviseRate: 30 }).m.reviseCyclesP95 === 2);
      const s = pipe('assistant', P.assistant.expert_copilot.inputs, { pattern: 'single' });
      const fmDef = NS.catalog.modelById(s.arch.models.fastModel), rmDef = NS.catalog.modelById(s.arch.models.reasoningModel);
      const f = s.arch.models.smartRouting ? s.arch.models.routingSplit / 100 : 0;
      const stream = P.assistant.expert_copilot.inputs.tokensOut * (f * fmDef.msPerOutTok + (1 - f) * rmDef.msPerOutTok);
      assert('a single agent streams: first token = full minus the streaming tail', s.m.latencyStartIsGated === false && Math.abs(s.m.latencyP95 - s.m.latencyStartP95 - stream) < 0.5 && s.m.latParts.some(p => p.stream > 0 && p.stream < p.ms));
      assert('agent QPS, model-call QPS, and the fan-out reconcile', Math.abs(x.m.qpsModelPeak - x.m.qpsAgentPeak * x.arch.agent.modelCallsPerReq) < 1e-9 && x.m.qpsAgentPeak <= x.m.volPeak);
      assert("in-flight at peak follows Little's law and instances respect the HA floor", Math.abs(x.m.inflightPeak - x.m.qpsAgentPeak * x.m.latencyP95 / 1000) < 1e-9 && x.m.agentInstances >= NS.catalog.K.perf.instMin);
      const stx = pipe('assistant', P.assistant.expert_copilot.inputs, { stateStore: 'alloydb' });
      assert('state sizing is single-sourced into the state-store cost line', stx.cs.priced.some(c => c.name === 'AlloyDB (state)' && c.calc.includes(`${stx.m.dbNodes} read-pool`)));
      assert('every perf calc string carries substituted numbers', ['ingress', 'agentQps', 'modelQps', 'inflight', 'instances', 'tok', 'state'].every(k => typeof x.m.perfCalc[k] === 'string' && /\d/.test(x.m.perfCalc[k])));
    }
    {
      /* Heavy grounding (BigQuery scan) so the long-answer full p95 lands in the
         10-12s window; expert_copilot's default AlloyDB read is too fast for this. */
      const longIn = clone(P.assistant.expert_copilot.inputs); longIn.tokensOut = 1000; longIn.dataSources = ['bigquery', 'doc_corpus'];
      const x = pipe('assistant', longIn);
      assert('long answers blow the 10s start budget before the 12s full budget and lint first-token', x.m.latencyStartOverBudget === true && x.m.latencyOverBudget === false && x.lint.some(l => /First token/.test(l.msg)));
      const es = pipe('assistant', P.assistant.enterprise_search.inputs);
      assert('sub-second carries no start budget; interactive and agentic do', es.m.latencyStartBudget === Infinity && x.m.latencyStartBudget === 10000);
      const esi = clone(P.assistant.enterprise_search.inputs); esi.latencyPreset = 'interactive';
      const esix = pipe('assistant', esi);
      assert('high peak token throughput recommends Provisioned Throughput', esix.m.needsProvisionedThroughput === true && esix.lint.some(l => /Provisioned Throughput/.test(l.msg)));
      const ec = pipe('assistant', P.assistant.expert_copilot.inputs);
      assert('low-volume designs stay on shared quota (no PT lint)', ec.m.needsProvisionedThroughput === false && !ec.lint.some(l => /Provisioned Throughput/.test(l.msg)));
      assert('a cache-on design sends only the misses to the agent', es.m.qpsAgentPeak < es.m.volPeak && es.arch.caching.responseCacheOn);
      assert('agentic budgets exceed what the default architecture achieves', ec.m.latencyBudget === 12000 && ec.m.latencyStartBudget === 10000 && !ec.m.latencyOverBudget && !ec.m.latencyStartOverBudget);
      assert('the three assistant SLO tiers each derive their own pattern', pipe('assistant', Object.assign(clone(P.assistant.expert_copilot.inputs), { latencyPreset: 'subsecond' })).dv('pattern') === 'none' && pipe('assistant', Object.assign(clone(P.assistant.expert_copilot.inputs), { latencyPreset: 'interactive' })).dv('pattern') === 'single' && ec.dv('pattern') === 'multi');
    }
    {
      const hv = Object.assign(clone(P.assistant.expert_copilot.inputs), { actors: 1e6, actionsPerDay: 50, burst: 8, activeHoursPerWeek: 168, corpusSize: 1e5 });
      const x = pipe('assistant', hv, { ragEngine: 'selfbuilt', vectorDB: 'vertex' });
      assert('vector serving nodes take the wider of the size and QPS bounds', x.m.vvsNodesQps > x.m.vvsNodesSize && x.m.vvsNodes === x.m.vvsNodesQps);
      assert('the QPS-sized vector fleet flows into the Vector Search cost line', x.cs.priced.some(c => c.name === 'Vector Search' && c.calc.indexOf(`${x.m.vvsNodes} x `) === 0));
    }
    {
      const hy = clone(P.assistant.expert_copilot.inputs); hy.deployment = 'hybrid';
      const x = pipe('assistant', hy);
      assert('hybrid computes link utilisation and stays far from saturation', x.m.linkMbpsPeak > 0 && x.m.linkUtilPct < NS.catalog.K.perf.linkSatPct && !x.lint.some(l => /saturates/.test(l.msg)));
      assert('gcp deployment carries no link metrics', pipe('assistant', P.assistant.expert_copilot.inputs).m.linkMbpsPeak == null);
      const sat = Object.assign(clone(P.assistant.expert_copilot.inputs), { deployment: 'hybrid', actors: 1e6, actionsPerDay: 50, burst: 8, activeHoursPerWeek: 168 });
      assert('a hot hybrid link lints before it saturates', pipe('assistant', sat).lint.some(l => /saturates/.test(l.msg)));
    }
    {
      const big = Object.assign(clone(P.automation.internal_lowstakes.inputs), { actors: 50000, actionsPerDay: 60, tokensOut: 2000, modelStrategy: 'self_host' });
      const x = pipe('automation', big);
      assert('self-host fleet capacity covers the peak it was sized for', x.m.gpuFleetTPS >= x.m.gpuPeakOutTPS && x.m.gpuHeadroomPct >= 0 && /\d.*tok\/s/.test(x.m.perfCalc.gpu));
      assert('automation has no first-token metric (async runs)', x.m.latencyStartP95 === null && x.m.latencyStartOverBudget === false);
    }

    /* ---- 6e. practices from the interview scripts (08-13) ---- */
    {
      const ec = pipe('assistant', P.assistant.expert_copilot.inputs);
      assert('regulated corpus derives DLP de-identification before import (managed path)', ec.dv('dlpDeidIngest') === true && ec.arch.retrieval.dlpDeidIngest === true && ec.comps.includes('Cloud DLP (ingest de-identify)') && ec.cs.priced.some(c => c.name === 'Cloud DLP (ingest de-identify)' && /backfill/.test(c.calc)));
      const low = clone(P.assistant.expert_copilot.inputs); low.audienceSensitivity = 'internal_low';
      const lo = pipe('assistant', low);
      assert('internal-low corpus skips de-identification, plain import edge preserved', lo.dv('dlpDeidIngest') === false && /Idx -\. crawl \+ parse \+ embed \.-> Store/.test(lo.dg) && !/DLPDeid/.test(lo.dg) && !lo.comps.includes('Cloud DLP (ingest de-identify)'));
      const slf = pipe('assistant', P.assistant.self_managed.inputs);
      assert('self-built pipeline de-identifies between parse and embed', /DocAI -\.-> DLPDeid/.test(slf.dg) && /DLPDeid -\.-> Emb/.test(slf.dg) && !/DocAI -\.-> Emb/.test(slf.dg));
      assert('de-identification pinned off at a regulated tier lints privacy', pipe('assistant', P.assistant.expert_copilot.inputs, { dlpDeidIngest: false }).lint.some(l => l.sev === 'privacy' && l.src === 'dlpDeidIngest'));
    }
    {
      const cs = pipe('assistant', P.assistant.customer_support.inputs);
      assert('customer-facing path redacts inbound PII at the gateway before any model call', cs.arch.models.inboundChips.includes('PII redact'));
      assert('customer-facing assistant draws the human handoff (never trap the user)', cs.arch.gov.humanHandoff === true && /Handoff/.test(cs.dg) && /escalate/.test(cs.dg));
      assert('external semantic cache lints per-tenant namespacing', cs.lint.some(l => l.src === 'semanticCache' && /tenant/.test(l.msg)));
      const ec = pipe('assistant', P.assistant.expert_copilot.inputs);
      const il = clone(P.assistant.expert_copilot.inputs); il.audienceSensitivity = 'internal_low';
      assert('regulated tiers redact inbound PII too; internal-low keeps the light edge; no internal handoff', ec.arch.models.inboundChips.includes('PII redact') && !pipe('assistant', il).arch.models.inboundChips.includes('PII redact') && ec.arch.gov.humanHandoff === false && !/Handoff/.test(ec.dg));
    }
    {
      const ca = pipe('assistant', P.assistant.conversational_analytics.inputs);
      assert('text-to-SQL leg carries the SQL gates and the scan-cost lever', /SQL gates · dry-run \+ bytes cap --> Live/.test(ca.dg) && ca.lint.some(l => /maximum-bytes-billed/.test(l.msg)));
      const lo = pipe('automation', P.automation.internal_lowstakes.inputs);
      assert('automation surfaces compounded task success and the narrow-agent guard lint', Math.abs(lo.m.runSuccessPct - Math.pow(0.99, Math.min(lo.arch.agent.reactMaxIter, 8)) * 100) < 0.1 && pipe('automation', P.automation.internal_lowstakes.inputs, { reactMaxIter: 12 }).lint.some(l => l.src === 'reactMaxIter' && /compounds/.test(l.msg)));
      assert('the guard never lowers the expected-step metric (12-step guard still compounds over 8)', pipe('automation', P.automation.internal_lowstakes.inputs, { reactMaxIter: 12 }).m.runSuccessSteps === 8);
      assert('assistants carry no compounded-success metric', pipe('assistant', P.assistant.expert_copilot.inputs).m.runSuccessPct == null);
      assert('semantic-layer guidance is an off-diagram lever, not a node', !/SemLayer/.test(ca.dg) && ca.lint.some(l => /semantic layer/i.test(l.msg)));
      {
        const oltpIn = clone(P.assistant.conversational_analytics.inputs);
        oltpIn.dataSources = (oltpIn.dataSources || []).concat(['alloydb_oltp']);
        oltpIn.latencyPreset = 'interactive';
        const o = pipe('assistant', oltpIn);
        assert('AlloyDB joins the Live data box with a read-only MCP edge; BigQuery keeps SQL gates', o.arch.retrieval.liveSel.includes('alloydb_oltp') && /BigQuery · AlloyDB/.test(o.dg) && /-- MCP tool-call · read-only --> Live/.test(o.dg) && /-- SQL gates · dry-run \+ bytes cap --> Live/.test(o.dg));
        assert('AlloyDB surfaces read-only + read-pool-freshness lints, no AlloyDB SLO conflict on interactive', o.lint.some(l => l.src === 'dataSources' && /read-only/i.test(l.msg)) && o.lint.some(l => l.src === 'dataSources' && /replication lag/i.test(l.msg)) && !o.lint.some(l => l.sev === 'conflict' && /AlloyDB/i.test(l.msg)));
        assert('AlloyDB bills a priced read-pool BoM line', o.comps.includes('AlloyDB read pool') && o.cs.priced.some(c => c.name === 'AlloyDB read pool' && c.mo > 0 && /read-pool/.test(c.calc)));
        assert('AlloyDB on the no-agent sub-second path conflicts (cannot be queried)', pipe('assistant', (() => { const a = clone(oltpIn); a.latencyPreset = 'subsecond'; return a; })()).lint.some(l => l.sev === 'conflict' && /can never be queried/.test(l.msg)));
      }
      /* State-op rates apply to a bring-your-own store (self-managed). Managed Agent
         Runtime persists state in Sessions, so it bills no separate state ops. */
      const smAuto = pipe('automation', (() => { const b = clone(P.automation.internal_lowstakes.inputs); b.opsModel = 'self_managed'; return b; })());
      assert('self-managed automation checkpoints per step (cap + 2); self-managed assistants stay at 3; managed bills 0', Math.abs(smAuto.m.stateOpsPeak - smAuto.m.qpsAgentPeak * (smAuto.arch.agent.reactMaxIter + 2)) < 1e-9 && (() => { const e = pipe('assistant', P.assistant.self_managed.inputs); return Math.abs(e.m.stateOpsPeak - e.m.qpsAgentPeak * 3) < 1e-9; })() && lo.m.stateOpsPeak === 0);
      assert('chunk math matches the parsed document (48 chunks/doc) and CJK scales ingestion ~1.8x', (() => {
        const base = pipe('assistant', P.assistant.self_managed.inputs);
        const zhIn = clone(P.assistant.self_managed.inputs); zhIn.languages = ['en', 'zh'];
        const zh = pipe('assistant', zhIn);
        const expect = 2e6 * 48 * 768 * 4 / 1e9;
        return Math.abs(base.m.indexGB - expect) < 1 && Math.abs(zh.m.indexGB - expect * 1.8) < 1 && zh.cs.priced.some(c => c.name === 'Embeddings (ingestion)' && /CJK/.test(c.calc));
      })());
      assert('Document AI prices the classify-first blend; the embedding backfill prices the batch tier', (() => {
        const slf = pipe('assistant', P.assistant.self_managed.inputs);
        const dai = slf.cs.priced.find(c => c.name === 'Document AI');
        const emb = slf.cs.priced.find(c => c.name === 'Embeddings (ingestion)');
        return !!dai && /classify-first/.test(dai.calc) && !!emb && /batch tier/.test(emb.calc);
      })());
    }

    /* ---- 7. decisions registry covers every derived decision ---- */
    {
      const r = NS.derive('assistant', P.assistant.expert_copilot.inputs, {});
      const regKeys = new Set(NS.presets.DECISIONS.map(d => d.key));
      const derKeys = Object.keys(r.decisions);
      assert('every derived decision has a registry row and vice versa', derKeys.every(k => regKeys.has(k)) && [...regKeys].every(k => derKeys.includes(k)));
      assert('every decision carries an auto value, pin flag, and why', derKeys.every(k => 'auto' in r.decisions[k] && 'pinned' in r.decisions[k] && r.decisions[k].why));
    }

    /* ---- 8. permalink round-trip (browser only; app module owns the codec) ---- */
    if (NS.app && NS.app.encodeState && NS.app.decodeState) {
      const snap = { v: 2, p: 'assistant', pr: 'expert_copilot', c: true, i: clone(P.assistant.expert_copilot.inputs), o: { stateStore: 'spanner', routingSplit: 55 } };
      const back = NS.app.decodeState(NS.app.encodeState(snap));
      assert('permalink round-trip preserves inputs, pins, and the custom flag', JSON.stringify(back) === JSON.stringify(snap));
      assert('a malformed hash decodes to null', NS.app.decodeState('not-base64!') === null);
    }

    const pass = results.every(r => r[1]);
    return { pass, results };
  }

  function renderBar() {
    const { pass, results } = run();
    const bar = document.getElementById('testbar');
    if (bar) {
      bar.style.display = 'block';
      bar.className = pass ? 'pass' : 'fail';
      bar.innerHTML = (pass ? 'all self-tests pass - ' : 'FAILURES - ') + results.map(r => `${r[1] ? '✓' : '✗'} ${r[0]}`).join(' · ');
    }
    console.log('[asd2 self-test]', pass ? 'PASS' : 'FAIL', results.filter(r => !r[1]));
    return pass;
  }

  NS.selfTest = { run, renderBar, fp };
})(typeof window !== 'undefined' ? (window.ASD2 = window.ASD2 || {}) : (globalThis.ASD2 = globalThis.ASD2 || {}));
