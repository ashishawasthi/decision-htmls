/* Agentic System Designer v2 - the one-way derivation core.
   derive(purpose, inputs, overrides) -> { decisions, arch, lint }
   Pure: no memory of previous calls, never mutates its arguments, and never
   writes back into inputs or overrides. Every low-level decision the original
   tool kept as a mutable override (agentic-system-designer.html lines 1625-1783)
   is an auto rule here; a sparse overrides entry pins a decision to an explicit
   value, and a contradictory pin raises a lint instead of being rewritten. */
(function (NS) {
  'use strict';
  const C = () => NS.catalog;

  /* Model-choice helpers (self-hosting is a model axis, not a deployment axis). */
  const isSelfHostModel = id => id === 'llama4-selfhost';

  /* Model calls per request: agents x a damped ReAct loop. */
  function modelCallsPerReq(pattern, numAgents, reactMaxIter) {
    const agents = pattern === 'multi' ? (numAgents || 1) : 1;
    const iters = pattern === 'multi' ? Math.max(1, reactMaxIter || 1) : 1;
    return Math.max(1, Math.round(agents * (1 + (iters - 1) * 0.5)));
  }

  /* Governance posture: a pure consequence of the trust tier, purpose, sources,
     and scale. Ported from deriveGovernance (lines 1793-1839); read-only in v2. */
  function deriveGovernance(purpose, inputs) {
    const { aud, lvl } = C().SENS[inputs.audienceSensitivity];
    const auto = purpose === 'automation';
    const ext = aud !== 'internal';
    const hasWeb = inputs.dataSources.includes('web');
    const tools = auto || inputs.dataSources.some(s => ['onprem', 'bigquery', 'web', 'kg', 'stream'].includes(s));
    const highVol = (inputs.actors || 0) * (inputs.actionsPerDay || 0) >= 1e5;
    const G = [];
    const set = (key, label, on, why, cat) => { G.push({ key, label, on, why, cat }); };
    set('gateway', inputs.deployment === 'hybrid' ? 'Private ingress auth (IAP + mTLS) + Model Armor' : 'API gateway + Model Armor (IAP + Apigee)', lvl >= 2 || ext,
      lvl >= 2 ? 'regulated+' : ext ? (aud === 'public' ? 'public' : 'external') : 'not required', 'access');
    set('auditLog', 'Immutable audit log', lvl >= 2 || ext,
      lvl >= 2 ? 'regulated+' : ext ? 'external' : 'not required', 'access');
    set('toolAuthz', 'Agent identity & tool authz', tools && (auto || ext || lvl >= 2),
      !tools ? 'no privileged tools' : auto ? 'automation tools' : ext ? 'external + tools' : lvl >= 2 ? 'regulated + tools' : 'internal low-stakes', 'access');
    set('residencyPin', 'Data residency pin', lvl >= 2,
      lvl >= 3 ? 'strict-PII' : lvl >= 2 ? 'regulated+' : 'not required', 'data');
    set('sandbox', 'Transient sandbox', lvl >= 3 || (auto && ext),
      lvl >= 3 ? 'strict-PII' : (auto && ext) ? 'external automation' : 'not required', 'data');
    set('dataAccessAudit', 'Data Access audit logs (managed stores)', lvl >= 2 || ext,
      lvl >= 2 ? 'regulated+' : ext ? 'external' : 'not required', 'data');
    set('guardrails', 'Safety guardrails (injection / output)', ext || hasWeb || lvl >= 3,
      lvl >= 3 ? 'strict-PII' : ext ? (aud === 'public' ? 'public' : 'external') : hasWeb ? 'web-sourced content' : 'internal trusted', 'safety');
    set('rulesEngine', 'Deterministic rules engine', auto, auto ? 'automation actions' : 'not required', 'safety');
    set('costKillSwitch', 'Cost guardrails / kill-switch', highVol || ext || auto,
      highVol ? 'high volume' : ext ? 'external exposure' : auto ? 'automation' : 'low-volume internal', 'safety');
    const hitl = auto ? (lvl >= 3 ? 'dual' : 'maker_checker') : 'none';
    G.push({
      key: 'hitlApproval', label: 'Human approval', on: hitl !== 'none', value: hitl, cat: 'ops',
      why: hitl === 'dual' ? 'strict-PII automation' : hitl === 'maker_checker' ? 'automation merge' : 'assistant (no auto-action)'
    });
    set('modelRiskGov', 'Model risk governance', lvl >= 2, lvl >= 2 ? 'regulated+' : 'not required', 'ops');
    set('safeRollout', 'Safe rollout + eval gates', lvl >= 2 || ext || highVol,
      lvl >= 2 ? 'regulated+' : ext ? 'external' : highVol ? 'high volume' : 'low blast radius', 'ops');
    set('feedbackLoop', 'Human feedback loop', !auto || ext,
      !auto ? 'assistant quality' : ext ? 'external product' : 'internal batch', 'ops');
    return G;
  }

  function derive(purpose, inputs, overrides) {
    const cat = C();
    const ov = overrides || {};
    const i = inputs;
    const sens = cat.SENS[i.audienceSensitivity] || cat.SENS.internal_regulated;
    const auto = purpose === 'automation';
    /* Automation runs async at per-run minutes; the SLO input only applies to assistants.
       Derived here (the original coerced inputs.latencyPreset in place, line 1758). */
    const effLatency = auto ? 'minutes' : i.latencyPreset;
    const subsecond = !auto && effLatency === 'subsecond';
    const interactive = !auto && effLatency === 'interactive';
    const hasIndex = i.dataSources.some(s => cat.INDEXED_SRC.includes(s));
    const chunks = (i.corpusSize || 0) * cat.K.chunksPerDoc;
    const dailyActions = (i.actors || 0) * (i.actionsPerDay || 0);
    const hybrid = i.deployment === 'hybrid';
    const selfManaged = i.opsModel === 'self_managed';
    const selfHostModels = i.modelStrategy === 'self_host';

    const decisions = {};
    const lint = [];
    const add = (sev, msg, save, src) => lint.push({ sev, msg, save: save || '', src });
    const resolve = (key, autoVal, why) => {
      const pinned = Object.prototype.hasOwnProperty.call(ov, key);
      const value = pinned ? ov[key] : autoVal;
      decisions[key] = { value, auto: autoVal, pinned, why };
      return value;
    };
    const d = k => decisions[k].value;

    /* ---- topology ---- */
    resolve('multiRegion', false, 'regional by default; turn on for active-active failover and locality');

    /* ---- agent ---- */
    resolve('agentRuntime', (selfManaged || selfHostModels) ? 'gke' : 'agentengine',
      selfManaged ? 'self-managed platform runs the agent on GKE' : selfHostModels ? 'a self-host model needs the agent next to the in-VPC fleet' : 'managed platform uses Agent Runtime');
    resolve('pattern', auto ? 'multi' : (subsecond ? 'none' : (interactive ? 'single' : 'multi')),
      auto ? 'automation runs a parallel executor team'
        : subsecond ? 'no external model call fits 1s - Agent Search answers directly, no agent'
          : interactive ? 'a 5s budget fits one streaming agent, not a validated team'
            : 'assistant quality from a generate-evaluate-revise team');
    /* The no-agent path: Agent Search's bundled question answering IS the system.
       No agent compute, no external model call, no tools, no run state. */
    const answerOnly = !auto && d('pattern') === 'none';
    resolve('numAgents', auto ? 5 : 4, 'specialist roles for the purpose');
    resolve('reactMaxIter', 6, 'damped loop default');
    resolve('reviseRate', 20, 'one in five drafts fails the quality gate and triggers a revise');
    resolve('platform', 'adk', 'ADK on the managed runtime is the default stack');

    /* ---- models and routing ---- */
    resolve('reasoningModel', selfHostModels ? 'llama4-selfhost' : 'gemini-35-flash',
      selfHostModels ? 'self-hosted open weights' : 'managed API default');
    resolve('fastModel', selfHostModels ? 'llama4-selfhost' : 'gemini-31-flash-lite',
      selfHostModels ? 'self-hosted open weights' : 'cheapest fast managed model');
    resolve('smartRouting', true, 'route lookups to the fast model');
    resolve('routingSplit', subsecond ? 85 : 70, subsecond ? 'sub-second biases to the fast model' : 'typical lookup share');
    resolve('judgeDiversity', false, 'single-vendor judging unless required');
    /* No agent = no model calls of ours, so no self-host fleet either. */
    const selfHostAny = (isSelfHostModel(d('reasoningModel')) || isSelfHostModel(d('fastModel'))) && !answerOnly;
    const selfHostAll = isSelfHostModel(d('reasoningModel')) && isSelfHostModel(d('fastModel')) && !answerOnly;

    /* ---- retrieval ---- */
    resolve('retrieval', !hasIndex ? 'none' : (subsecond ? 'hybrid' : 'rerank'),
      !hasIndex ? 'no indexed source to retrieve from' : subsecond ? 'hybrid without the reranker fits the sub-second budget' : 'hybrid + reranker for grounding quality');
    const ragOn = ['hybrid', 'dense', 'rerank'].includes(d('retrieval'));
    resolve('ragEngine', answerOnly ? 'vais' : (selfManaged ? 'selfbuilt' : 'vais'),
      answerOnly ? 'the no-agent path IS Agent Search bundled answering' : selfManaged ? 'self-managed platform owns the pipeline' : 'managed Agent Search bundles parse, index, retrieve, rerank');
    resolve('vectorDB', selfManaged ? 'alloydb' : 'vertex',
      selfManaged ? 'AlloyDB ScaNN index next to the state store' : 'Vertex AI Vector Search (ScaNN)');
    const selfbuilt = ragOn && d('ragEngine') === 'selfbuilt';
    resolve('metadataPrefilter', true, 'pre-filter keeps ANN recall at scale');
    resolve('ingestionSep', (i.corpusSize || 0) >= 5e6 && i.dataSources.includes('doc_corpus'),
      'separate ingestion from query serving for a 5M+ document corpus');

    /* ---- state ---- */
    resolve('stateStore',
      auto ? (d('multiRegion') ? 'spanner' : 'alloydb') : (d('multiRegion') ? 'redis_spanner' : 'redis_alloydb'),
      d('multiRegion') ? 'active-active multi-region writes need Spanner' : (auto ? 'AlloyDB is the regional transactional default' : 'Redis hot tier + AlloyDB durable is the regional assistant default'));
    resolve('contextCache', (i.tokensIn || 0) >= 2048, 'pays off above the ~2k-token minimum cacheable prefix');
    resolve('reuseInputPct', 50, 'typical shared system-prompt + retrieved fraction');

    /* ---- response caching ---- */
    const cacheWorthy = !auto && ['eod', 'static'].includes(i.freshness) && dailyActions >= 1e5;
    resolve('exactCache', cacheWorthy || selfManaged, cacheWorthy ? 'repeat-heavy, freshness-tolerant Q&A' : selfManaged ? 'self-managed designs ship the Redis cache' : 'off unless traffic is repeat-heavy and freshness-tolerant');
    resolve('semanticCache', cacheWorthy || selfManaged, cacheWorthy ? 'repeat-heavy, freshness-tolerant Q&A' : selfManaged ? 'self-managed designs ship the Redis cache' : 'off unless traffic is repeat-heavy and freshness-tolerant');
    resolve('autocomplete', false, 'opt-in lever');
    resolve('warming', false, 'opt-in lever');
    resolve('cacheHit', 5, 'conservative base hit rate');
    const responseCacheOn = !!(d('exactCache') || d('semanticCache'));

    /* ---- security ---- */
    const securePosture = sens.lvl >= 1;
    resolve('cmek', securePosture, securePosture ? 'every tier above internal-low ships customer-managed keys' : 'internal-low runs on Google-managed keys');
    resolve('enforceVpcSc', securePosture, securePosture ? 'every tier above internal-low ships the perimeter' : 'internal-low needs no perimeter');

    /* ---- self-host sizing ---- */
    resolve('accelerator', 'h100', 'default accelerator class');
    resolve('quant', 'fp8', 'precision vs quality default');
    resolve('pagedAttn', true, 'vLLM default');
    resolve('gpuTier', 'cud_3y', 'committed-use pricing for a steady fleet');
    resolve('gpuUtil', 70, 'realistic steady utilisation');

    /* ---- consolidated topology flags (the single source every output reads) ---- */
    const gke = d('agentRuntime') === 'gke' && !answerOnly;
    const redisTier = /redis/.test(d('stateStore'));
    const redisSelf = redisTier && gke;
    const redisOnGke = gke && (redisTier || responseCacheOn);
    const cacheInVpc = responseCacheOn && gke;
    /* Self-built pipeline compute (the retrieval funnel) is drawn for assistants
       only; automation folds retrieval into the agent and reads the store directly. */
    const retrInVpc = selfbuilt && !auto;
    const llmSelf = selfHostAny;
    /* The dedicated VPC wraps self-hosted compute only; managed stores sit outside
       over PSC endpoints. Hybrid always needs one for its Cloud Router. */
    const anySelfHosted = gke || llmSelf || retrInVpc;
    resolve('dedicatedVpc', anySelfHosted || hybrid,
      hybrid ? 'hybrid terminates its Cloud Router in a dedicated VPC' : anySelfHosted ? 'wraps the self-hosted compute' : 'nothing self-hosted, so no VPC box is needed');
    const vpcMembers = [];
    if (cacheInVpc) vpcMembers.push('Cache');
    if (gke) vpcMembers.push('AE');
    if (retrInVpc) vpcMembers.push('Retr');
    if (redisSelf) vpcMembers.push('State');
    if (llmSelf) vpcMembers.push('LLM');
    if (hybrid) vpcMembers.push('CloudRouter');
    const vpcDrawn = !!d('dedicatedVpc') && vpcMembers.length > 0;

    const governance = deriveGovernance(purpose, i);
    const gov = Object.fromEntries(governance.map(g => [g.key, g.value !== undefined ? g.value : g.on]));
    /* Model Armor screens model traffic; the no-agent path has none of its own
       (Agent Search applies its own safety filters; the gateway keeps the
       inbound injection screen). */
    const armorOn = !!(gov.guardrails || gov.residencyPin || gov.toolAuthz) && !answerOnly;

    /* Inbound (API gateway) and outbound (model leg) control chips. Hybrid is
       private-only ingress: the public gateway collapses to a light IAP / mTLS hop. */
    const inboundFull = [];
    if (gov.gateway) { inboundFull.push('auth'); inboundFull.push('rate-limit'); }
    if (sens.lvl >= 3) inboundFull.push('PII redact');
    if (gov.guardrails) inboundFull.push('injection screen');
    const inboundChips = hybrid ? (inboundFull.length ? [cat.LIGHT_AUTH] : []) : inboundFull;
    const outboundChips = [];
    if (!answerOnly) {
      if (gov.gateway) { outboundChips.push('route'); outboundChips.push('fan-out'); }
      if (sens.lvl >= 3) outboundChips.push('PII redact');
      if (gov.guardrails) outboundChips.push('output filter');
      if (gov.auditLog) outboundChips.push('audit');
    }

    const idxSel = i.dataSources.filter(s => cat.INDEXED_SRC.includes(s));
    const liveSel = i.dataSources.filter(s => cat.LIVE_SRC.includes(s));
    const storeDrawn = ragOn && idxSel.length > 0;
    /* Selected sources the derived design actually consumes. The no-agent path
       reads only its index (live sources and web grounding need an agent);
       retrieval pinned off drops the indexed sources too. The difference is the
       set of inputs the user selected but this design ignores - the right panel
       reflects this (it never appears in the diagram/cost/BoM), and the input
       checkboxes dim to match, without ever being unchecked (inputs are never
       mutated by derivation, so raising the SLO restores them). */
    const usedSrc = new Set();
    if (storeDrawn) idxSel.forEach(s => usedSrc.add(s));
    if (!answerOnly) { liveSel.forEach(s => usedSrc.add(s)); if (i.dataSources.includes('web')) usedSrc.add('web'); }
    const ignoredSources = i.dataSources.filter(s => !usedSrc.has(s));

    /* Tool-call dispatch (ADK style): in a multi-agent team the Orchestrator
       dispatches every hand-off, a dedicated Retrieval agent owns the data
       tools, and the Generator only drafts. A single agent keeps every call on
       the Generator: it is the whole agent. The Retrieval agent is drawn only
       when the design has a data tool for it to own. */
    const multiAgent = d('pattern') === 'multi';
    const retrieverDrawn = multiAgent && (storeDrawn || retrInVpc || liveSel.length > 0 || i.dataSources.includes('web'));
    const stateLabel = redisTier
      ? `State store (${gke ? 'Redis on GKE' : 'Memorystore Cluster'})`
      : (cat.STATE_STORE_LABEL[d('stateStore')] || 'State store');
    const durTier = d('stateStore') === 'redis_alloydb' ? { label: 'AlloyDB<br/>durable', conn: 'PSC' }
      : d('stateStore') === 'redis_spanner' ? { label: 'Spanner<br/>active-active durable', conn: 'PSC' }
        : null;
    const stateManaged = !redisSelf;

    /* CMEK and Data Access audit cover the managed stores only. v2 delta vs the
       original: a self-built design's vector store is now itself a managed service
       (Vector Search / AlloyDB ScaNN), so it joins both target sets. */
    const kmsTargets = [];
    if (storeDrawn && selfbuilt) kmsTargets.push('Store');
    if (storeDrawn) kmsTargets.push('GCS');
    if (stateManaged && !answerOnly) kmsTargets.push('State');
    if (durTier && !answerOnly) kmsTargets.push('StateDur');
    if (responseCacheOn && !gke) kmsTargets.push('Cache');

    const arch = {
      purpose,
      effLatency,
      topology: {
        deployment: i.deployment, privateOnly: hybrid, hybridLink: hybrid,
        multiRegion: !!d('multiRegion'), vpcMembers, vpcDrawn, perimeterOn: !!d('enforceVpcSc'),
      },
      agent: {
        runtime: d('agentRuntime'), gke, pattern: d('pattern'), multiAgent, answerOnly,
        numAgents: d('numAgents'), reactMaxIter: d('reactMaxIter'), reviseRate: d('reviseRate'), platform: d('platform'),
        agentEntry: answerOnly ? 'Store' : (multiAgent ? 'Orchestrator' : 'Generator'),
        agentReview: multiAgent ? 'Validator' : 'Generator',
        retrieverDrawn,
        dataAgent: retrieverDrawn ? 'Retriever' : 'Generator',
        execAgent: multiAgent ? 'Orchestrator' : 'Generator',
        modelCallsPerReq: answerOnly ? 0 : modelCallsPerReq(d('pattern'), d('numAgents'), d('reactMaxIter')),
      },
      models: {
        reasoningModel: d('reasoningModel'), fastModel: d('fastModel'),
        smartRouting: !!d('smartRouting'), routingSplit: d('routingSplit'), judgeDiversity: !!d('judgeDiversity'),
        selfHostAny, selfHostAll, armorOn, inboundChips, outboundChips,
      },
      retrieval: {
        mode: d('retrieval'), ragOn, ragEngine: d('ragEngine'), selfbuilt, vectorDB: d('vectorDB'),
        idxSel, liveSel, hasIndex: idxSel.length > 0, hasWebGrounding: i.dataSources.includes('web') && !answerOnly,
        ignoredSources, retrInVpc, storeDrawn, gcsDrawn: storeDrawn,
        ingestionSep: !!d('ingestionSep'), metadataPrefilter: !!d('metadataPrefilter'),
      },
      state: {
        store: d('stateStore'), drawn: !answerOnly, redisTier, redisSelf, redisOnGke, stateInVpc: redisSelf,
        stateManaged, stateConn: redisSelf ? null : 'PSC', stateLabel, durTier,
      },
      caching: {
        responseCacheOn, exactCache: !!d('exactCache'), semanticCache: !!d('semanticCache'),
        cacheInVpc, autocomplete: !!d('autocomplete'), warming: !!d('warming'), cacheHitBase: d('cacheHit'),
        contextCache: !!d('contextCache') && !answerOnly, reuseInputPct: d('reuseInputPct'),
      },
      security: {
        cmek: !!d('cmek'), enforceVpcSc: !!d('enforceVpcSc'),
        kmsTargets, auditTargets: kmsTargets.slice(), secretManagerOn: redisOnGke,
        dataAccessAudit: !!gov.dataAccessAudit,
      },
      governance,
      gov,
      sizing: {
        accelerator: d('accelerator'), quant: d('quant'), pagedAttn: !!d('pagedAttn'),
        gpuTier: d('gpuTier'), gpuUtil: d('gpuUtil'),
      },
    };

    /* ---- lints: pin conflicts and input-level nudges (metric-independent) ---- */
    const pinned = k => decisions[k].pinned;
    const qa = !auto && hasIndex;
    if (qa && !d('autocomplete')) add('caching', 'Add query autocomplete - canonicalizes phrasings, lifts cache-hit ~5-15% to ~40-60% at near-zero inference cost.', 'cost down, latency down', 'autocomplete');
    if (d('autocomplete') && !d('warming')) add('caching', 'Precompute the top-N suggested queries offline: near-zero cost and milliseconds of latency on the popular head.', '', 'warming');
    if (subsecond && d('pattern') !== 'none') add('conflict', 'Sub-second runs no agent at all - any external model call (TTFT + decode) busts the 1s budget. Unpin Pattern, or raise the SLO to interactive (<5s, one streaming agent).', '', 'pattern');
    if (answerOnly && !hasIndex) add('conflict', 'The no-agent sub-second path answers from the Agent Search index, but no indexed source (document corpus or company website) is selected - add one, or raise the SLO.', '', 'latencyPreset');
    const agentNeedy = i.dataSources.filter(s => cat.LIVE_SRC.includes(s) || s === 'web').map(s => cat.SRC_LABEL[s] || s);
    if (answerOnly && agentNeedy.length) add('conflict', `No agent on the sub-second path - Agent Search answers only from its index, so ${agentNeedy.join(', ')} can never be queried. Remove them, or raise the SLO to interactive (one streaming agent with tools).`, 'latency down', 'latencyPreset');
    if (answerOnly && d('ragEngine') === 'selfbuilt') add('conflict', 'The no-agent path IS Agent Search bundled answering - a self-built pipeline needs an agent to run retrieval and generation. Unpin the engine, or raise the SLO.', '', 'ragEngine');
    if (answerOnly && selfHostModels) add('conflict', 'Self-hosted open weights need a serving fleet and an agent to call it - the no-agent sub-second path uses Agent Search bundled answering instead. Raise the SLO, or switch the model strategy to managed APIs.', '', 'modelStrategy');
    if (d('retrieval') === 'none' && hasIndex) add('conflict', 'A document corpus or website is selected but retrieval is pinned off, so it is never indexed or queried - set retrieval back to Auto, or remove the source.', '', 'retrieval');
    if (ragOn && !hasIndex) add('conflict', 'Retrieval is pinned on but there is no document corpus or company website to retrieve from - add an indexed source, or set retrieval back to Auto (live grounding and live data do not need it).', '', 'retrieval');
    if (selfHostAny && d('agentRuntime') === 'agentengine') add('conflict', 'Self-hosted model serves from a vLLM-on-GKE fleet in the VPC, but the agent is pinned to managed Agent Runtime (Cloud Run) - unpin Agent compute, or add a Serverless VPC Access connector.', '', 'agentRuntime');
    if (selfManaged && pinned('agentRuntime') && d('agentRuntime') === 'agentengine') add('conflict', 'The operating model is self-managed but Agent compute is pinned to the managed Agent Runtime - the platform pieces will not run on your GKE cluster.', '', 'agentRuntime');
    if (i.freshness === 'realtime' && responseCacheOn) add('conflict', 'Caching contradicts real-time freshness - scope to freshness-tolerant intents or shorten TTL.', '', 'exactCache');
    if (i.freshness === 'realtime' && !i.dataSources.includes('stream')) add('freshness', 'Real-time freshness usually implies a live streaming feed - add the Streaming data source, or relax freshness.', '', 'freshness');
    if (sens.lvl >= 3 && d('semanticCache')) add('privacy', 'Semantic cache stores query embeddings - isolate per tenant + short TTL, or disable under strict-PII.', '', 'semanticCache');
    if (selfbuilt && chunks > 1e8 && !d('metadataPrefilter')) add('scaling', 'Pure ANN recall degrades past ~100M chunks - add a metadata pre-filter + shard.', '', 'metadataPrefilter');
    if (d('multiRegion') && pinned('stateStore') && !String(d('stateStore')).includes('spanner')) add('conflict', 'Multi-region active-active is on but the state store is pinned to a single-primary store - AlloyDB / Cloud SQL cannot serve active-active writes; unpin to derive Spanner.', '', 'stateStore');
    if (hybrid && pinned('dedicatedVpc') && !d('dedicatedVpc')) add('conflict', 'Hybrid terminates its Cloud Router + VLAN attachment in a dedicated VPC - unpin the VPC to draw the interconnect correctly.', '', 'dedicatedVpc');
    if (pinned('dedicatedVpc') && d('dedicatedVpc') && vpcMembers.length === 0) add('conflict', 'The dedicated VPC is pinned on but nothing self-hosted lives in it - the box is only drawn around self-hosted compute; managed services connect over PSC instead.', '', 'dedicatedVpc');
    if (pinned('cmek') && !d('cmek') && sens.lvl >= 2) add('privacy', 'CMEK is pinned off at a regulated or strict-PII tier - data at rest falls back to Google-managed keys.', '', 'cmek');
    if (pinned('enforceVpcSc') && !d('enforceVpcSc') && sens.lvl >= 2) add('privacy', 'The VPC-SC perimeter is pinned off at a regulated or strict-PII tier - managed-API egress is unbounded.', '', 'enforceVpcSc');
    if (!answerOnly) {
      if (!d('contextCache') && (i.tokensIn || 0) >= 3000) add('cost', 'Largest cheap win: enable context cache on the reused system prompt - cached input bills at the model cache-read rate (~10% of input).', 'input cost down', 'contextCache');
      else if (d('contextCache') && (i.tokensIn || 0) < 2048) add('cost', 'Context cache is pinned on but the prompt is below the ~2k-token minimum cacheable size, so prompt caching will not apply.', '', 'contextCache');
      else if (d('contextCache') && (d('reuseInputPct') || 0) <= 10) add('cost', 'Context cache is on but reusable-input is ~0, so there is no shared prefix to cache and no saving - set reusable-input % to your real shared-prompt fraction, or pin it off.', '', 'reuseInputPct');
      else if (d('contextCache') && (i.tokensIn || 0) >= 3000 && (d('reuseInputPct') || 0) < 40) add('cost', 'Context cache on but low reuse % - set reusable-input toward your real shared-prompt/retrieved fraction to capture the discount.', 'input cost down', 'reuseInputPct');
    }
    if (i.dataSources.includes('website')) add('freshness', 'Crawled company-website content is indexed offline, so answers are only as fresh as the last crawl - set a re-crawl cadence that matches how fast the pages change.', '', 'website');
    if (i.dataSources.includes('web') && !answerOnly) {
      if ((cat.modelById(d('reasoningModel')).webSearch || 0) === 0) add('conflict', `Web grounding needs a model with a web-search tool (Gemini Google Search or Claude web search). ${cat.modelById(d('reasoningModel')).name} has none, so live web grounding will not run - switch the reasoning model or drop web grounding.`, '', 'reasoningModel');
      else if (!d('autocomplete')) add('cost', 'Live web grounding is billed per search - autocomplete + response cache cut repeat grounded calls on the popular head.', 'grounding down', 'autocomplete');
    }
    if (!d('smartRouting') && !answerOnly) add('cost', 'Route lookups to the fast model; reserve the reasoning model for hard queries.', '', 'smartRouting');
    if (auto) add('data', 'Keep durable audit and long-term event history in BigQuery, not the transactional state store - the state DB holds resumable run state; BigQuery holds the append-only history.', '', 'stateStore');
    if (subsecond && !answerOnly && i.dataSources.some(s => cat.LATENCY_HEAVY.includes(s))) {
      const slow = i.dataSources.filter(s => cat.LATENCY_HEAVY.includes(s)).map(s => cat.SRC_LABEL[s] || s);
      add('conflict', `Slow live sources on a sub-second path: ${slow.join(', ')} each add a query-time call that will not fit a 1s p95 - remove them from the hot path or raise the SLO.`, 'latency down', 'latencyPreset');
    }

    return { decisions, arch, lint };
  }

  NS.derive = derive;
  NS.deriveHelpers = { modelCallsPerReq, deriveGovernance };
})(typeof window !== 'undefined' ? (window.ASD2 = window.ASD2 || {}) : (globalThis.ASD2 = globalThis.ASD2 || {}));
