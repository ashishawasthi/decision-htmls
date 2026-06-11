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
    assert('revert: each data source add -> remove restores all outputs', ['web', 'onprem', 'stream', 'kg', 'website'].every(src => {
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
      const base = clone(P.automation.internal_lowstakes.inputs);
      const on = pipe('automation', base, { multiRegion: true });
      const off = pipe('automation', base, {});
      return on.dv('stateStore') === 'spanner' && off.dv('stateStore') === 'alloydb';
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
      assert('sub-second derives single-agent, hybrid retrieval, 85% fast routing', x.dv('pattern') === 'single' && x.dv('retrieval') === 'hybrid' && x.dv('routingSplit') === 85);
      assert('enterprise search derives response caching on', x.arch.caching.responseCacheOn);
      assert('enterprise search stays within the sub-second budget', x.m.latencyOverBudget === false);
      assert('enterprise search derives Agent Search + separated ingestion over the drawn store', x.dv('ragEngine') === 'vais' && x.dv('ingestionSep') === true && x.arch.retrieval.storeDrawn === true);
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
      assert('automation derives AlloyDB state + per-run minutes', low.dv('stateStore') === 'alloydb' && low.arch.effLatency === 'minutes');
      const sp = pipe('automation', P.automation.strictpii.inputs);
      assert('strict-PII automation mandates sandbox + gateway + residency + dual control', sp.arch.gov.sandbox === true && sp.arch.gov.gateway === true && sp.arch.gov.residencyPin === true && sp.arch.gov.hitlApproval === 'dual');
      assert('the sandbox is dispatched by the Orchestrator, not the Generator', /Orchestrator --> Sand/.test(sp.dg) && !/Generator --> Sand/.test(sp.dg));
    }

    /* ---- 4. domain invariants on the diagram and BoM ---- */
    {
      const x = pipe('assistant', P.assistant.expert_copilot.inputs);
      assert('fully managed design draws no VPC box, state over PSC', !/subgraph VPC\[/.test(x.dg) && /AE -\. state · PSC \.-> State/.test(x.dg));
      assert('fully managed design has no Secret Manager (diagram or BoM)', !/SecretMgr/.test(x.dg) && !x.comps.includes('Secret Manager'));
      assert('regulated tier draws the perimeter and lists VPC Service Controls', /subgraph PERIM/.test(x.dg) && x.comps.includes('VPC Service Controls'));
      assert('CMEK edges reach managed stores only', /KMS -\. encrypts \.-> GCS/.test(x.dg) && /KMS -\. encrypts \.-> StateDur/.test(x.dg) && !/KMS -\. encrypts \.-> Cache/.test(x.dg));
      assert('Data Access audit edges mirror the CMEK target set', x.arch.security.auditTargets.join() === x.arch.security.kmsTargets.join() && /-\. data access \.-> Audit/.test(x.dg));
      assert('multi-agent routes every hand-off through the Orchestrator (no point-to-point links)', /Orchestrator --> Generator/.test(x.dg) && /Orchestrator --> Validator/.test(x.dg) && /Validator -\. revise \.-> Orchestrator/.test(x.dg) && !/Generator --> Validator/.test(x.dg) && !/Validator -\. revise \.-> Generator/.test(x.dg) && !/Generator --> Orchestrator/.test(x.dg) && !/Retriever --> Orchestrator/.test(x.dg));
      assert('multi-agent data tools hang off the Retrieval agent, never the Generator', /Orchestrator --> Retriever/.test(x.dg) && /Retriever --> Live/.test(x.dg) && !/Generator --> Store/.test(x.dg) && !/Generator --> Live/.test(x.dg) && !/Generator --> WebG/.test(x.dg));
      assert('managed Agent Search folds retrieval into the store', !/Retrieval funnel/.test(x.dg) && /Retriever --> Store/.test(x.dg) && /Idx -\. crawl \+ parse \+ embed \.-> Store/.test(x.dg));
      assert('no HNSW or Elastic anywhere in diagram or BoM', !/HNSW|Elastic/i.test(x.dg) && !x.comps.some(c => /HNSW|Elastic/i.test(c)));
    }
    {
      const x = pipe('assistant', P.assistant.self_managed.inputs);
      const vb = vpcBlock(x.dg);
      assert('self-managed: GKE agent box and Redis tier inside the VPC', /subgraph AE/.test(vb) && /State\[\(/.test(vb) && /Cache\[\(/.test(vb));
      assert('self-managed: managed ScaNN store and durable tier outside the VPC over PSC', !/Store\[\(/.test(vb) && !/StateDur/.test(vb) && /Retr -- PSC --> Store/.test(x.dg) && /State -\. durable · PSC \.-> StateDur/.test(x.dg));
      assert('self-managed: the Retrieval agent fronts the in-VPC funnel', /Retriever --> Retr/.test(x.dg) && !/Generator --> Retr/.test(x.dg));
      assert('self-managed: SecretMgr drawn for the Redis AUTH and listed in the BoM', /AE -\. Redis AUTH \.-> SecretMgr/.test(x.dg) && x.comps.includes('Secret Manager'));
      assert('self-managed: CMEK covers the managed store but never in-VPC Redis', /KMS -\. encrypts \.-> Store/.test(x.dg) && !/KMS -\. encrypts \.-> State\b/.test(x.dg) && !/KMS -\. encrypts \.-> Cache/.test(x.dg));
      assert('self-managed: no Memorystore line (Redis rides the GKE line)', !x.comps.includes('Memorystore Cluster') && x.comps.includes('GKE Autopilot (agent)'));
    }
    {
      const hy = clone(P.assistant.expert_copilot.inputs); hy.deployment = 'hybrid'; hy.dataSources = ['doc_corpus', 'onprem'];
      const x = pipe('assistant', hy);
      assert('hybrid: private-only ingress (no Client UI / EdgeGW / Apigee / API Gateway)', !/Client UI/.test(x.dg) && !/EdgeGW/.test(x.dg) && !x.comps.includes('Apigee') && !x.comps.includes('Cloud API Gateway'));
      assert('hybrid: IAP / mTLS hop on the interconnect into the agent', /OnpremUsers == Cloud Interconnect ==> CloudRouter/.test(x.dg) && /CloudRouter -- IAP \/ mTLS --> Orchestrator/.test(x.dg));
      assert('hybrid: the Retrieval agent reads on-prem systems over the interconnect', /Retriever == over interconnect ==> OnpremDB/.test(x.dg) && !/Generator == over interconnect/.test(x.dg));
      assert('hybrid: dedicated VPC derives on for the Cloud Router', x.dv('dedicatedVpc') === true && /subgraph VPC\[/.test(x.dg));
      assert('hybrid: latency swaps the gateway hop for a 3ms IAP check', x.m.latParts.some(p => p.label === 'IAP / mTLS' && p.ms === 3) && !x.m.latParts.some(p => p.label === 'API Gateway'));
      assert('hybrid: BoM keeps Cloud IAP', x.comps.includes('Cloud IAP'));
      const gcp = pipe('assistant', P.assistant.expert_copilot.inputs);
      assert('gcp keeps the public door and gateway SKUs (no regression)', /Client UI/.test(gcp.dg) && gcp.comps.includes('Apigee') && gcp.comps.includes('Cloud API Gateway') && !/ONPREM/.test(gcp.dg));
    }
    {
      const x = pipe('assistant', P.assistant.enterprise_search.inputs);
      assert('single-agent box holds the Generator only, tools stay on the Generator', /Generator\[/.test(x.dg) && !/Orchestrator/.test(x.dg) && !/Validator/.test(x.dg) && !/Retriever/.test(x.dg) && /Generator --> Store/.test(x.dg));
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
      assert('a slow source forced onto sub-second flags the latency metric', x.m.latencyOverBudget === true && x.lint.some(l => l.src === 'latencyPreset'));
    }

    /* ---- 6. metrics and cost sanity (ported from the original self-test) ---- */
    {
      const x = pipe('assistant', P.assistant.expert_copilot.inputs);
      assert('optimized cost never exceeds the naive baseline', x.m.costOpt <= x.m.costNaive);
      assert('peak volume is at least the average', x.m.volPeak >= x.m.volAvg);
      assert('latency parts sum to the p95 total', Math.abs(x.m.latParts.reduce((s, p) => s + p.ms, 0) - x.m.latencyP95) < 1 && x.m.latParts.length > 0);
      assert('platform cost adds to GenAI in the run-rate', x.cs.platMo > 0 && Math.abs(x.cs.totalMo - ((x.m.costOpt || 0) + (x.m.gpuMo || 0) + x.cs.platMo)) < 1e-6);
      assert('BigQuery is volume-modeled', x.cs.priced.some(c => c.name === 'BigQuery'));
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
      const g2 = clone(base); g2.dataSources = ['doc_corpus', 'bigquery', 'onprem'];
      assert('parallel grounding takes the max, not the sum', pipe('assistant', g1).m.latencyP95 === pipe('assistant', g2).m.latencyP95);
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
      assert('below the line reconciles and never enters the run-rate', Math.abs(man.cs.allInMo - (man.cs.totalMo + man.cs.btlMo)) < 1e-6 && Math.abs(man.cs.totalMo - (man.cs.genai + man.cs.platMo)) < 1e-6);
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
