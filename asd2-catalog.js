/* Agentic System Designer v2 - catalog: pure data, no logic.
   Ported from agentic-system-designer.html (MODELS lines 1569-1575, K 1576-1602,
   DIAGRAM_PALETTE 1538-1561, source lists 2015-2096, docs map 2106-2151, BOM notes
   2767-2798). Keep the numbers in sync with the original until it is retired.
   v2 changes: K.hnsw dropped (managed vector stores - Vertex AI Vector Search,
   AlloyDB - use ScaNN, so there are no HNSW tuning knobs or recall curves), and
   the Elasticsearch vector store option is gone (the store is always managed). */
(function (NS) {
  'use strict';

  /* $/1M tokens for in/out/cacheRead; webSearch = $ per 1k web-search/grounding calls
     (0 = the model has no web search tool). ttftMs = time to first token;
     msPerOutTok = generation ms per output token. Illustrative ~May 2026. */
  const MODELS = [
    { id: 'gemini-3-pro', name: 'Gemini 3 Pro', in: 2.0, out: 12.0, cacheRead: 0.20, webSearch: 14.0, ttftMs: 550, msPerOutTok: 0.75 },
    { id: 'gemini-35-flash', name: 'Gemini 3.5 Flash', in: 1.5, out: 9.0, cacheRead: 0.15, webSearch: 14.0, ttftMs: 400, msPerOutTok: 0.5 },
    { id: 'gemini-31-flash-lite', name: 'Gemini 3.1 Flash-Lite', in: 0.25, out: 1.5, cacheRead: 0.025, webSearch: 14.0, ttftMs: 180, msPerOutTok: 0.3 },
    { id: 'claude-opus-48', name: 'Claude Opus 4.8', in: 5.0, out: 25.0, cacheRead: 0.50, webSearch: 10.0, ttftMs: 600, msPerOutTok: 0.9 },
    { id: 'llama4-selfhost', name: 'Llama 4 (self-host)', in: 0, out: 0, cacheRead: 0, webSearch: 0, ttftMs: 500, msPerOutTok: 0.7 },
  ];
  const modelById = id => MODELS.find(m => m.id === id) || MODELS[0];

  const K = {
    dim: 768, chunksPerDoc: 5, bytesPerFloat: 4,
    apigeeRpsPerRegion: 30000, embedTokPerWorkerDay: 2.0e9,
    hoursMo: 730,
    /* Self-host fleet sizing. nodeTokPerSec = decode tok/s for a 70B-active model at
       FP8 on one 8-accelerator node. costHr is per 8-accelerator node ($/hr) per tier. */
    gpu: {
      nodeTokPerSec: 8000, baseActiveB: 70, refActiveB: 17, moePenalty: 0.5,
      precMult: { bf16: 1.0, fp8: 2.0, int4: 2.8 },
      accel: {
        h100: { tpsMult: 1.0, costHr: { on_demand: 88.49, cud_3y: 38.86, spot: 37.92 } },
        b200: { tpsMult: 2.2, costHr: { on_demand: 130.0, cud_3y: 62.00, spot: 55.00 } },
        tpu: { tpsMult: 1.3, costHr: { on_demand: 64.00, cud_3y: 32.00, spot: 24.00 } },
      },
    },
    storageBQ: 0.02, storageGCS: 0.02,
    bqScanMB: 50, bqStorageGB: 200, bqOnDemandPerTiB: 6.25,
    /* Agent Search (managed RAG): ~$3 per 1k queries + index storage $/GiB-mo + a website data store base. */
    vais: { perQuery: 0.003, storageGiB: 5, websiteBase: 30 },
    lat: { retrieval: 70, rerank: 80, bigqueryScan: 1200, webGround: 600, onpremCall: 400, qualityGate: 80, cacheExact: 5, cacheSem: 30 },
    /* Fixed ingestion assumptions (the original exposed these in a drill-down sub-calculator). */
    ingestion: { docsPerDayFactor: 0.002, docPages: 40 },
  };

  /* Node colours for the architecture diagram, per theme. Mermaid bakes these into
     the SVG via classDef, so the diagram is rebuilt on a theme switch. */
  const DIAGRAM_PALETTE = {
    dark: {
      perim: '#9aa5b1',
      vpc: '#6ea8ff',
      client: { fill: '#16384a', stroke: '#5ec8f8', color: '#dbeefb' },
      gateway: { fill: '#40301a', stroke: '#f4a259', color: '#ffe6cc' },
      orch: { fill: '#2a2348', stroke: '#7c5cff', color: '#e7e0ff' },
      retr: { fill: '#143a32', stroke: '#4cd4b0', color: '#d6fff3' },
      data: { fill: '#3a3416', stroke: '#e6c84c', color: '#fff7cc' },
      obs: { fill: '#23272e', stroke: '#9aa5b1', color: '#e6edf3' },
      gov: { fill: '#3a1a2a', stroke: '#ff6b9d', color: '#ffd6e6' },
    },
    light: {
      perim: '#6e7781',
      vpc: '#3b6fd4',
      client: { fill: '#dbeefb', stroke: '#0a7ea4', color: '#06323f' },
      gateway: { fill: '#ffe6cc', stroke: '#bc6716', color: '#3d2406' },
      orch: { fill: '#e7e0ff', stroke: '#6639ba', color: '#2a1a4d' },
      retr: { fill: '#d6fff3', stroke: '#137a63', color: '#06302a' },
      data: { fill: '#fff7cc', stroke: '#9a7d0a', color: '#3a3416' },
      obs: { fill: '#eaedf1', stroke: '#6e7781', color: '#23272e' },
      gov: { fill: '#ffd6e6', stroke: '#c2255c', color: '#3a1a2a' },
    },
  };

  /* Data sources: indexed content (crawled/parsed/embedded offline), live-queried
     sources, and live web grounding via the model web-search tool. */
  const SRC_LABEL = { bigquery: 'BigQuery', onprem: 'On-prem', stream: 'Stream', kg: 'KG', web: 'Web', website: 'Site', doc_corpus: 'Corpus' };
  const INDEXED_SRC = ['doc_corpus', 'website'];
  const LIVE_SRC = ['bigquery', 'onprem', 'kg', 'stream'];
  const INDEXED_LABEL = { doc_corpus: 'Docs', website: 'Site' };
  /* Sources with a slow query-time call: BigQuery scan, on-prem fetch, live web search. */
  const LATENCY_HEAVY = ['bigquery', 'onprem', 'web'];
  /* p95 budget (ms) per latency preset on the assistant path. */
  const LATENCY_BUDGET = { subsecond: 1000, agentic: 6000, minutes: Infinity };

  const STATE_STORE_LABEL = {
    redis: 'State store (Memorystore)',
    redis_spanner: 'State store (Redis + Spanner)',
    redis_alloydb: 'State store (Redis + AlloyDB)',
    alloydb: 'State store (AlloyDB)',
    spanner: 'State store (Spanner)',
    cloudsql: 'State store (Cloud SQL)',
  };

  /* Per-chip milliseconds for the request-side (inbound) and model-leg (outbound)
     control-plane halves. */
  const IN_LAT = { 'auth': 8, 'rate-limit': 2, 'PII redact': 8, 'injection screen': 20, 'IAP / mTLS': 3 };
  const OUT_LAT = { 'route': 4, 'fan-out': 3, 'PII redact': 8, 'output filter': 20, 'audit': 3 };
  const LIGHT_AUTH = 'IAP / mTLS';

  /* Audience and sensitivity tiers. lvl: 0 internal-low, 1 external-enterprise,
     2 regulated, 3 strict-PII. */
  const SENS = {
    internal_low: { aud: 'internal', lvl: 0 },
    internal_regulated: { aud: 'internal', lvl: 2 },
    internal_strictpii: { aud: 'internal', lvl: 3 },
    external_enterprise: { aud: 'external', lvl: 1 },
    external_regulated: { aud: 'external', lvl: 2 },
    public_strictpii: { aud: 'public', lvl: 3 },
  };

  /* One-line purpose per diagram box, keyed by node id. Shown on hover. */
  const NODE_PURPOSE = {
    Client: 'The user-facing app (web or chat) that sends queries and renders grounded, cited answers.',
    EdgeGW: 'The request-side API gateway at the system edge: authenticates the caller (IAM + mTLS), enforces per-tenant rate limits, redacts inbound PII, and screens for prompt injection and jailbreaks before anything reaches the agent. Implemented by Apigee, Cloud API Gateway, or a third-party gateway. Shows only the controls your inputs require. Sized on inbound user QPS.',
    Armor: 'Model Armor screens every model call inline: it filters prompt injection and jailbreaks on the way in and redacts or blocks unsafe or leaking output on the way out. It sees every model call, so it sizes on model-call QPS (user QPS x fan-out), not user QPS.',
    Orchestrator: 'Inside Agent compute: decomposes the request into steps, calls tools and retrieval, coordinates the generate-evaluate-revise loop, and composes the final answer.',
    Generator: 'Inside Agent compute: calls the models through Model Armor and reads retrieval to produce the draft, then revises it from the Validator critique until it passes (the Self-Refine loop).',
    GeneratorSingle: 'Inside Agent compute: the single agent. It plans the request, calls the models through Model Armor, reads retrieval, and produces the final answer in one pass - there is no separate orchestrator or validator critique loop.',
    Validator: 'Inside Agent compute: the automated quality gate. It evaluates the draft against the acceptance criteria and, on a fail, returns a critique to the Generator to revise; on a pass the answer is returned or sent for human review.',
    SecretMgr: 'Secret Manager holds the AUTH credential for the self-hosted Redis-on-GKE tier (the hot state tier and/or the response cache). Every other dependency authenticates through the agent service account via IAM / Workload Identity Federation, so no other secret is stored. Provisioned only when Redis on GKE is in the design.',
    KMS: 'Cloud KMS holds the customer-managed encryption key (CMEK). It encrypts the managed data-at-rest stores - Cloud Storage, the managed state store, the durable tier, the managed Memorystore cache - so data at rest is under a key you own. Self-hosted stores (Redis on GKE) use disk and application encryption instead.',
    Cache: 'A response cache on the request path: on a hit it returns a stored answer and skips the agent and model entirely. Exact-match keys on the normalized query; semantic match keys on the query embedding. Invalidation is TTL (set from data freshness) plus version busting (key namespaced by model, prompt, and index version).',
    Retr: 'Narrows candidates in stages (metadata pre-filter, dense + BM25, rerank) so the model is grounded on only the most relevant passages.',
    Sand: 'Runs PII-sensitive or untrusted tool execution in an ephemeral, isolated instance that is wiped after each use.',
    LLM: 'The reasoning and fast models. Smart routing sends easy lookups to the cheap model and hard queries to the reasoning model.',
    Store: 'The index that retrieval reads at query time. Managed (Agent Search) or self-built on a managed ScaNN-backed vector store (Vertex AI Vector Search or AlloyDB). Populated offline by the ingestion branch, never at request time.',
    Idx: 'The content indexed offline into the store: the document corpus and crawled company website pages. Re-crawled and re-embedded on a schedule, so the index is only as fresh as the last run.',
    GCS: 'Cloud Storage holds the source documents and the packaged agent artifact. It feeds the offline index; it is not read at request time.',
    Live: 'Sources queried live at request time (BigQuery text-to-SQL, on-prem DB, knowledge graph, streaming), not pre-indexed.',
    WebG: 'Live web grounding via the model web-search tool (Gemini Google Search or Claude web search) for fresh, public, non-owned content. Billed per search; not available on self-hosted Llama.',
    DocAI: 'Parses source documents and pages into clean structured text (layout, tables, OCR) before chunking and embedding, and extracts entities that ride along as searchable metadata.',
    Emb: 'Splits parsed content into chunks, embeds them, and writes the vectors plus a BM25 index into the managed vector store.',
    Obs: 'Traces, logs, and evals for every step, so quality, latency, and cost stay measurable and regressions get caught.',
    Appr: 'A human review step (maker-checker or dual-control) before a high-stakes action is committed. Async: the run pauses here and resumes only when a reviewer approves.',
    Fb: 'Captures thumbs and reasons from users and feeds them into the eval set, so quality does not silently decay.',
    Trig: 'The event that starts a run: a ticket, a webhook, or a scheduled job.',
    State: 'Transactional run and session state, so long workflows and conversations can resume after a failure. Default is AlloyDB: PostgreSQL-compatible, HA, with pgvector/ScaNN for agent memory, and cheaper than Spanner for a single region. Use Spanner for active-active multi-region writes. Durable audit and long-term event history belong in BigQuery.',
    StateDur: 'Durable tier paired with the hot Redis cache: AlloyDB (regional HA) by default, or Spanner (active-active multi-region writes) when the design needs them. Both are managed services reached over a Private Service Connect endpoint, so they live outside the dedicated VPC.',
    CloudRouter: 'Terminates the on-prem Cloud Interconnect inside the dedicated VPC (Cloud Router + VLAN attachment). The sole ingress in a hybrid deployment.',
    OnpremUsers: 'The on-premise network: users and callers reach the system over the private interconnect, not the public internet.',
    OnpremDB: 'On-premise systems of record the agent reads back over the same private link.',
  };

  /* Role of each data source, shown as a hover tooltip on the checkbox. */
  const DATA_SOURCE_ROLE = {
    doc_corpus: 'Document corpus parsed, chunked, and embedded for RAG (Document AI ingestion), then served from the vector store.',
    onprem: 'On-prem or legacy system of record reached over a private link. Latency varies, so validate it fits the SLO.',
    stream: 'Streaming or event source (Pub/Sub, Kafka) for fresh, near-real-time context.',
    kg: 'Knowledge graph for entity and relationship lookups and multi-hop reasoning.',
    web: 'Live web grounding via the model web-search tool (Gemini Google Search or Claude web search) for fresh, public content the company does not own. Per-search cost; self-hosted Llama has no web search tool.',
    website: 'Company website pages (owned) crawled and indexed into Agent Search (website data store) or a self-built crawler, then served from the index like documents.',
    bigquery_assistant: 'Analytical / structured grounding via text-to-SQL. Conditional fit: keep it off the sub-second hot path and pair it with an indexed source for RAG.',
    bigquery_automation: 'Primary grounding and data-processing source. Async minute-scale runs absorb its query latency, so large scans and joins are fine.',
  };

  /* Google Cloud component explainers (separate pages under components/, opened in
     a new tab). Keyed by the exact BoM chip / display name. */
  const COMPONENT_DOC = {
    'BigQuery': 'components/bigquery.html',
    'Vector Search': 'components/vertex-vector-search.html',
    'Agent Search': 'components/vertex-ai-search.html',
    'Spanner': 'components/spanner.html',
    'AlloyDB': 'components/alloydb.html',
    'AlloyDB (state)': 'components/alloydb.html',
    'Memorystore Cluster': 'components/memorystore.html',
    'Apigee': 'components/apigee.html',
    'Model Armor': 'components/model-armor.html',
    'Cloud DLP': 'components/cloud-dlp.html',
    'VPC Service Controls': 'components/vpc-service-controls.html',
    'Document AI': 'components/document-ai.html',
    'Dataflow': 'components/dataflow.html',
    'vLLM on GKE': 'components/vllm-gke.html',
    'ADK + Agent Runtime': 'components/agent-engine.html',
    'Agent Studio': 'components/agent-studio.html',
    'LangGraph': 'components/langgraph.html',
    'Self-managed infra + ops (LangGraph)': 'components/langgraph.html',
    'LangGraph Platform Enterprise (self-host license)': 'components/langgraph.html',
    'Cloud Logging (WORM)': 'components/cloud-logging.html',
    'Cloud Audit Logs (Data Access)': 'components/cloud-audit-logs.html',
    'Cloud Trace': 'components/cloud-trace.html',
    'Agent Platform Evals': 'components/vertex-ai-eval.html',
    'Model Registry': 'components/vertex-model-registry.html',
    'On-prem DB': 'components/onprem.html',
    'Pub/Sub': 'components/pubsub.html',
    'Knowledge graph': 'components/knowledge-graph.html',
    'Web/OSINT': 'components/web-osint.html',
  };
  const MODEL_DOC = {
    'Gemini 3 Pro': 'components/model-gemini-3-pro.html',
    'Gemini 3.5 Flash': 'components/model-gemini-35-flash.html',
    'Gemini 3.1 Flash-Lite': 'components/model-gemini-31-flash-lite.html',
    'Claude Opus 4.8': 'components/model-claude-opus-48.html',
    'Llama 4 (self-host)': 'components/model-llama4-selfhost.html',
  };
  const DS_COMPONENT = { bigquery: 'BigQuery', doc_corpus: 'Document AI', stream: 'Pub/Sub', onprem: 'On-prem DB', kg: 'Knowledge graph', web: 'Web/OSINT', website: 'Agent Search' };
  const docFor = name => COMPONENT_DOC[name] || MODEL_DOC[name] || null;

  /* Inline assumption shown next to a cost estimate whose per-request volume is
     assumed rather than derived from inputs. */
  const BOM_EST_NOTE = {
    'BigQuery': {
      note: `~${K.bqScanMB} MB scanned/req`,
      why: `On-demand BigQuery at $${K.bqOnDemandPerTiB}/TiB scanned, assuming ~${K.bqScanMB} MB per request after the 1 TiB/mo free tier, plus ~${K.bqStorageGB} GB stored at $${K.storageBQ}/GB-mo. Partitioning and clustering can push the scan well below this illustrative figure.`,
    },
    'Cloud Audit Logs (Data Access)': {
      note: 'Data Access stream only',
      why: 'Only the Data Access audit stream is billed - as standard Cloud Logging ingestion at $0.50/GiB past the 50 GiB/project/month free tier. Admin Activity, System Event, and Policy Denied logs are always-on and free. The estimate assumes a handful of data-access entries per request and scales with request volume.',
    },
    'ADK + Agent Runtime': {
      note: 'managed runtime bundled',
      why: 'Bundles the managed runtime on Agent Platform: sessions, state, autoscaling, and tracing. You do not provision or monitor that infrastructure yourself, unlike the self-hosted LangGraph path, so there is no separate ops line.',
    },
    'Agent Studio': {
      note: 'managed runtime bundled',
      why: 'Bundles the managed runtime on Agent Platform: sessions, state, autoscaling, and tracing. You do not provision or monitor that infrastructure yourself, unlike the self-hosted LangGraph path, so there is no separate ops line.',
    },
    'LangGraph': {
      note: 'framework only (free OSS)',
      why: 'The LangGraph library is open source (MIT), so the framework itself is free. The compute that runs it, plus storage and monitoring, is the Self-managed infra + ops line; the supported self-hosted path also needs the LangGraph Platform Enterprise line.',
    },
    'Self-managed infra + ops (LangGraph)': {
      note: 'K8s + Postgres + Redis + monitoring',
      why: 'Illustrative floor for running LangGraph yourself: a Kubernetes cluster, a PostgreSQL checkpoint store, Redis for streaming, and self-hosted monitoring. A fixed floor that scales with peak concurrency, plus the per-request compute that executes each run. Ops and on-call labor is additional and not dollarized here.',
    },
    'LangGraph Platform Enterprise (self-host license)': {
      note: 'custom, ~$2k-5k/mo (illustrative $5k)',
      why: 'Self-hosting LangGraph is a LangGraph Platform / LangSmith Enterprise add-on. Pricing is custom and not published; third-party estimates put mid-size contracts around $2,000 to $5,000 per month. Contact LangChain sales for a real quote.',
    },
  };

  /* Formatting helpers shared by the render and self-test modules. */
  const fmt = (n, d = 0) => { if (n == null || isNaN(n)) return '-'; const a = Math.abs(n); if (a >= 1e9) return (n / 1e9).toFixed(d || 1) + 'B'; if (a >= 1e6) return (n / 1e6).toFixed(d || 1) + 'M'; if (a >= 1e3) return (n / 1e3).toFixed(d || 1) + 'k'; return n.toFixed(d); };
  const money = n => { if (n == null || isNaN(n)) return '-'; return '$' + Math.round(n).toLocaleString('en-US'); };

  NS.catalog = {
    MODELS, modelById, K, DIAGRAM_PALETTE,
    SRC_LABEL, INDEXED_SRC, LIVE_SRC, INDEXED_LABEL, LATENCY_HEAVY, LATENCY_BUDGET,
    STATE_STORE_LABEL, IN_LAT, OUT_LAT, LIGHT_AUTH, SENS,
    NODE_PURPOSE, DATA_SOURCE_ROLE,
    COMPONENT_DOC, MODEL_DOC, DS_COMPONENT, docFor, BOM_EST_NOTE,
    fmt, money,
  };
})(typeof window !== 'undefined' ? (window.ASD2 = window.ASD2 || {}) : (globalThis.ASD2 = globalThis.ASD2 || {}));
