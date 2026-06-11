/* Agentic System Designer v2 - presets and the decisions registry.
   A preset is a pure bundle of left-panel INPUT values and nothing else: it never
   touches a derived decision. The old preset override-mutations map onto the two
   new inputs instead (opsModel replaces the Self-Managed GKE/self-built seeding,
   modelStrategy replaces picking the self-host model entry by hand).
   Workload numbers ported from agentic-system-designer.html lines 1606-1623. */
(function (NS) {
  'use strict';

  const DEFAULT_INPUTS = {
    actors: 1000, actionsPerDay: 10, burst: 5, activeHoursPerWeek: 50,
    latencyPreset: 'agentic', tokensIn: 4000, tokensOut: 800,
    audienceSensitivity: 'internal_regulated',
    dataSources: ['bigquery', 'doc_corpus'], corpusSize: 2e6, freshness: 'eod', languages: ['en'],
    deployment: 'gcp', opsModel: 'managed', modelStrategy: 'api',
  };
  /* Build a preset input bundle: the defaults plus the per-preset values. */
  const inp = over => Object.assign({}, DEFAULT_INPUTS, over);

  const PRESETS = {
    assistant: {
      expert_copilot: {
        label: 'Expert copilot',
        desc: 'Internal expert copilot that answers from a document corpus and BigQuery at agentic speed.',
        inputs: inp({}),
      },
      self_managed: {
        label: 'Self-Managed',
        desc: 'Interactive assistant that self-manages the agent, retrieval pipeline, and cache on GKE under CMEK and a VPC-SC perimeter, on a managed ScaNN vector store.',
        inputs: inp({ dataSources: ['doc_corpus'], opsModel: 'self_managed' }),
      },
      highvol_qa: {
        label: 'High-volume Q&A',
        desc: 'Very high-volume Q&A over a large document corpus, tuned for sub-second latency and low cost per query.',
        inputs: inp({ actors: 20000, actionsPerDay: 50, burst: 6, activeHoursPerWeek: 120, latencyPreset: 'subsecond', tokensIn: 3000, tokensOut: 500, dataSources: ['doc_corpus'], corpusSize: 1e7, freshness: 'static' }),
      },
      customer_support: {
        label: 'Customer support',
        desc: 'External, multilingual customer support grounded on a support corpus at agentic latency.',
        inputs: inp({ actors: 50000, actionsPerDay: 4, burst: 7, activeHoursPerWeek: 168, tokensIn: 2500, tokensOut: 600, audienceSensitivity: 'external_enterprise', dataSources: ['doc_corpus'], corpusSize: 5e5, languages: ['en', 'zh', 'ja'] }),
      },
      strictpii_verify: {
        label: 'Strict-PII verification',
        desc: 'Low-volume, strict-PII verification that grounds live on web, knowledge graph, and on-prem data in real time.',
        inputs: inp({ actors: 300, actionsPerDay: 8, burst: 3, tokensIn: 6000, tokensOut: 1000, audienceSensitivity: 'internal_strictpii', dataSources: ['web', 'kg', 'onprem'], corpusSize: 0, freshness: 'realtime' }),
      },
    },
    automation: {
      /* Presets differ by trust tier (audience and sensitivity), the one input that
         changes the automation design: each tier mandates a different governance posture. */
      internal_lowstakes: {
        label: 'Internal · low-stakes',
        desc: 'Internal low-stakes automation with light governance, running at minutes-scale latency.',
        inputs: inp({ actors: 300, actionsPerDay: 6, burst: 3, latencyPreset: 'minutes', tokensIn: 8000, tokensOut: 2000, audienceSensitivity: 'internal_low', dataSources: ['bigquery', 'onprem'], corpusSize: 0 }),
      },
      self_managed: {
        label: 'Self-Managed',
        desc: 'Regulated internal automation that self-manages the agent, retrieval pipeline, and cache on GKE under CMEK and a VPC-SC perimeter, on a managed ScaNN vector store.',
        inputs: inp({ actors: 800, actionsPerDay: 6, burst: 4, activeHoursPerWeek: 80, latencyPreset: 'minutes', tokensIn: 8000, tokensOut: 2000, dataSources: ['doc_corpus'], opsModel: 'self_managed' }),
      },
      strictpii: {
        label: 'Strict-PII / high-stakes',
        desc: 'Strict-PII, high-stakes automation that mandates a sandbox, Model Armor, and data residency.',
        inputs: inp({ actors: 400, actionsPerDay: 8, burst: 3, activeHoursPerWeek: 60, latencyPreset: 'minutes', tokensIn: 8000, tokensOut: 2000, audienceSensitivity: 'internal_strictpii', dataSources: ['bigquery', 'onprem'], corpusSize: 0 }),
      },
      external_facing: {
        label: 'External-facing',
        desc: 'External-facing automation with stronger guardrails for untrusted users and multilingual output.',
        inputs: inp({ actors: 1500, actionsPerDay: 4, activeHoursPerWeek: 120, latencyPreset: 'minutes', tokensIn: 6000, tokensOut: 1500, audienceSensitivity: 'external_regulated', dataSources: ['bigquery'], corpusSize: 0, languages: ['en', 'zh'] }),
      },
    },
  };

  /* Tooltip text for the left-panel inputs, keyed by input name. */
  const INPUT_HELP = {
    actors: 'Number of distinct users or seats the system serves.',
    actionsPerDay: 'Requests each actor makes per day; sets the monthly request volume.',
    tokensIn: 'Average input and output tokens per query; drives token cost and generation latency.',
    corpusSize: 'Documents in the grounding corpus to index for retrieval.',
    latencyPreset: 'Target response-time service level the design must meet. Sub-second derives a single-agent path, hybrid retrieval, and a fast-model routing bias; slow sources left selected are flagged on the latency metric instead of being removed.',
    burst: 'Peak-to-average load multiplier, for sizing against spikes.',
    activeHoursPerWeek: 'Hours per week of active use the load is averaged over.',
    audienceSensitivity: 'Who sees the output and how sensitive the data is. Drives the governance posture, CMEK, and the VPC-SC perimeter.',
    freshness: 'How current the grounding data must be. Real-time freshness pairs with a streaming source and conflicts with response caching.',
    deployment: 'Connectivity, not where inference runs. GCP: the managed system, reached publicly. Hybrid: the same system plus a private link to your on-premise network over an existing Cloud Interconnect; hybrid is private-only ingress (no public client or API gateway, a light IAP / mTLS hop instead).',
    opsModel: 'Operating model for the platform pieces. Managed: Agent Runtime, Agent Search, managed stores. Self-managed: the agent, retrieval pipeline, and cache run on GKE that you operate; the vector store stays a managed ScaNN service (AlloyDB).',
    modelStrategy: 'Managed token-metered APIs (Gemini / Claude), or self-hosted open weights served from a vLLM-on-GKE fleet that you size and pay for by the node-hour.',
    dataSources: 'Where answers are grounded: indexed content (corpus, website), live-queried sources, and live web grounding.',
    languages: 'Languages the system must understand and respond in.',
  };

  /* The derived-decisions registry. Every decision renders as one row whose first
     option is "Auto: <derived value>"; picking any other value pins it (stored
     sparsely in state.overrides), and picking Auto unpins it. Types:
       enum  - fixed option list
       bool  - Auto / On / Off
       steps - numeric options generated from min/max/step
     vis(d, inputs, purpose) gates the row on the RESOLVED decision values. */
  const onMulti = d => d.pattern === 'multi';
  const onSelfbuilt = d => d.retrieval !== 'none' && d.ragEngine === 'selfbuilt';
  const onSelfhost = d => d.reasoningModel === 'llama4-selfhost' || d.fastModel === 'llama4-selfhost';

  const DECISIONS = [
    /* Topology */
    { key: 'multiRegion', group: 'Topology', label: 'Multi-region active-active', type: 'bool', help: 'Run active in multiple regions for failover and locality. Auto stays regional; turning it on derives a Spanner durable tier.' },
    { key: 'dedicatedVpc', group: 'Topology', label: 'Dedicated VPC network', type: 'bool', help: 'A private network for the self-hosted parts of the system, distinct from the VPC-SC service perimeter. Auto draws it exactly when something self-hosted (GKE compute, vLLM fleet, Redis on GKE, the hybrid Cloud Router) is in the design; managed stores are reached from it over Private Service Connect endpoints.' },
    /* Agent */
    { key: 'agentRuntime', group: 'Agent', label: 'Agent compute', type: 'enum', options: [{ v: 'agentengine', label: 'Agent Runtime (managed)' }, { v: 'gke', label: 'GKE Autopilot' }], help: 'Where the agent runs. Auto follows the operating model and model strategy: managed Agent Runtime unless the platform is self-managed or a self-host model needs an in-VPC fleet.' },
    { key: 'pattern', group: 'Agent', label: 'Pattern', type: 'enum', options: [{ v: 'single', label: 'Single agent' }, { v: 'multi', label: 'Multi-agent' }], help: 'One agent, or a coordinated team. Auto picks multi-agent except at a sub-second SLO, where the single-agent path protects the TTFT budget.' },
    { key: 'numAgents', group: 'Agent', label: 'Specialist agents', type: 'steps', min: 1, max: 12, step: 1, vis: onMulti, help: 'Specialist agents in the multi-agent team.' },
    { key: 'reactMaxIter', group: 'Agent', label: 'ReAct max iterations', type: 'steps', min: 1, max: 12, step: 1, vis: onMulti, help: 'Maximum reason-act-observe loops allowed per request; drives the model-call fan-out.' },
    { key: 'platform', group: 'Agent', label: 'Platform', type: 'enum', options: [{ v: 'adk', label: 'ADK' }, { v: 'studio', label: 'Agent Studio' }, { v: 'langgraph', label: 'LangGraph' }], help: 'Agent framework and runtime that hosts the system.' },
    /* Models and routing */
    { key: 'reasoningModel', group: 'Models & routing', label: 'Model for high reasoning', type: 'enum', options: 'MODELS', help: 'Primary model for the hard reasoning steps. Auto follows the model strategy.' },
    { key: 'fastModel', group: 'Models & routing', label: 'Model for fast lookups', type: 'enum', options: 'MODELS', help: 'Cheaper, faster model for simple or lookup steps. Auto follows the model strategy.' },
    { key: 'smartRouting', group: 'Models & routing', label: 'Smart routing', type: 'bool', help: 'Send simple requests to the fast model, hard ones to the reasoning model.' },
    { key: 'routingSplit', group: 'Models & routing', label: '% to fast model', type: 'steps', min: 0, max: 100, step: 5, vis: d => d.smartRouting, help: 'Share of traffic routed to the fast model. Auto biases to 85% at a sub-second SLO, 70% otherwise.' },
    { key: 'judgeDiversity', group: 'Models & routing', label: 'Cross-model judge diversity', type: 'bool', help: 'Use a different model to check or judge outputs.' },
    /* Retrieval */
    { key: 'retrieval', group: 'Retrieval', label: 'Strategy', type: 'enum', options: [{ v: 'none', label: 'None' }, { v: 'dense', label: 'Pure dense' }, { v: 'hybrid', label: 'Hybrid (dense+BM25)' }, { v: 'rerank', label: 'Hybrid + reranker' }], help: 'Grounding retrieval strategy at query time. Auto turns it on exactly when an indexed source (corpus, website) is selected, and drops the reranker at a sub-second SLO.' },
    { key: 'ragEngine', group: 'Retrieval', label: 'Indexing & retrieval engine', type: 'enum', options: [{ v: 'vais', label: 'Managed: Agent Search' }, { v: 'selfbuilt', label: 'Self-built pipeline + managed store' }], vis: d => d.retrieval !== 'none', help: 'Managed Agent Search (parse, chunk, embed, index, retrieve, rerank in one service), or a self-built ingestion and query pipeline on top of a managed ScaNN-backed vector store.' },
    { key: 'vectorDB', group: 'Retrieval', label: 'Vector store (managed, ScaNN)', type: 'enum', options: [{ v: 'vertex', label: 'Vertex AI Vector Search' }, { v: 'alloydb', label: 'AlloyDB (ScaNN index)' }], vis: onSelfbuilt, help: 'Managed ScaNN-backed store behind the self-built pipeline. Both are managed services reached over PSC; neither sits in the VPC.' },
    { key: 'metadataPrefilter', group: 'Retrieval', label: 'Metadata pre-filter', type: 'bool', vis: onSelfbuilt, help: 'Filter candidates by metadata before the vector search.' },
    { key: 'ingestionSep', group: 'Retrieval', label: 'Ingestion separation', type: 'bool', vis: onSelfbuilt, help: 'Index on a separate pipeline from query serving. Auto turns this on for a 5M+ document corpus.' },
    /* State and context cache */
    { key: 'stateStore', group: 'State & context cache', label: 'State store', type: 'enum', options: [{ v: 'alloydb', label: 'AlloyDB' }, { v: 'redis_alloydb', label: 'Redis + AlloyDB' }, { v: 'spanner', label: 'Spanner' }, { v: 'redis_spanner', label: 'Redis + Spanner' }, { v: 'cloudsql', label: 'Cloud SQL' }, { v: 'redis', label: 'Memorystore (Redis Cluster)' }], help: 'Where transactional run and agent state is kept. Auto: a Redis hot tier + AlloyDB for assistants, plain AlloyDB for automation; the durable tier becomes Spanner when multi-region active-active is on. Audit history goes to BigQuery either way.' },
    { key: 'contextCache', group: 'State & context cache', label: 'Context cache (system prompt)', type: 'bool', help: 'Bill the reusable prompt prefix at the cache-read rate (~10% of input). Gemini caches a stable prefix implicitly; Claude needs a cache_control breakpoint; self-hosted Llama uses vLLM prefix caching. Needs a prefix above the ~2k-token minimum cacheable size, which is what Auto checks.' },
    { key: 'reuseInputPct', group: 'State & context cache', label: 'Reusable / cacheable input %', type: 'steps', min: 0, max: 90, step: 5, vis: d => d.contextCache, help: 'Share of input that is a stable, cacheable prefix. Realized by ordering the prompt fixed-part-first: system instructions, context, and few-shot at the start, the variable user turn at the end.' },
    /* Response caching */
    { key: 'exactCache', group: 'Response caching', label: 'Exact-match cache', type: 'bool', help: 'Reuse a stored answer when the exact query repeats. Auto turns it on for repeat-heavy, freshness-tolerant assistants and for the self-managed platform.' },
    { key: 'semanticCache', group: 'Response caching', label: 'Semantic cache', type: 'bool', help: 'Reuse a stored answer when a similar query repeats.' },
    { key: 'autocomplete', group: 'Response caching', label: 'Query autocomplete', type: 'bool', help: 'Suggest canonical query phrasings to lift cache hits.' },
    { key: 'warming', group: 'Response caching', label: 'Cache warming', type: 'bool', help: 'Precompute answers for the most popular queries.' },
    { key: 'cacheHit', group: 'Response caching', label: 'Base cache-hit %', type: 'steps', min: 0, max: 80, step: 5, vis: d => d.exactCache || d.semanticCache, help: 'Baseline response-cache hit rate from exact and semantic caching; autocomplete and warming add on top, capped at 80%.' },
    /* Security */
    { key: 'cmek', group: 'Security', label: 'Customer-managed keys (CMEK)', type: 'bool', help: 'Encrypt the managed stores with customer-managed keys in Cloud KMS. Auto follows the audience and sensitivity tier: on for every tier above internal-low. Self-hosted stores take disk and app encryption, not a managed key.' },
    { key: 'enforceVpcSc', group: 'Security', label: 'VPC-SC perimeter', type: 'bool', help: 'Wrap the Google services in a VPC Service Controls perimeter, a data-egress boundary around managed APIs, distinct from the dedicated VPC network. Auto follows the audience and sensitivity tier.' },
    /* Self-hosted inference */
    { key: 'accelerator', group: 'Self-hosted inference', label: 'Accelerator', type: 'enum', options: [{ v: 'h100', label: 'H100 SXM5' }, { v: 'b200', label: 'B200' }, { v: 'tpu', label: 'TPU v6 Trillium' }], vis: onSelfhost, help: 'GPU or TPU class for self-hosted inference.' },
    { key: 'quant', group: 'Self-hosted inference', label: 'Quantization', type: 'enum', options: [{ v: 'bf16', label: 'BF16' }, { v: 'fp8', label: 'FP8' }, { v: 'int4', label: 'INT4' }], vis: onSelfhost, help: 'Model weight precision for self-hosting.' },
    { key: 'pagedAttn', group: 'Self-hosted inference', label: 'PagedAttention', type: 'bool', vis: onSelfhost, help: 'Paged attention for higher GPU memory efficiency.' },
    { key: 'gpuTier', group: 'Self-hosted inference', label: 'Pricing tier', type: 'enum', options: [{ v: 'on_demand', label: 'On-demand' }, { v: 'cud_3y', label: '3-year CUD' }, { v: 'spot', label: 'Spot' }], vis: onSelfhost, help: 'Pricing commitment for the self-host GPU fleet.' },
    { key: 'gpuUtil', group: 'Self-hosted inference', label: 'Steady utilisation %', type: 'steps', min: 20, max: 100, step: 5, vis: onSelfhost, help: 'Assumed steady GPU utilisation used to size the fleet.' },
  ];

  NS.presets = { PRESETS, DEFAULT_INPUTS, DECISIONS, INPUT_HELP };
})(typeof window !== 'undefined' ? (window.ASD2 = window.ASD2 || {}) : (globalThis.ASD2 = globalThis.ASD2 || {}));
