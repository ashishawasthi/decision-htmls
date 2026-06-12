/* Agentic System Designer v2 - catalog: pure data, no logic.
   Ported from agentic-system-designer.html (MODELS lines 1569-1575, K 1576-1602,
   DIAGRAM_PALETTE 1538-1561, source lists 2015-2096, docs map 2106-2151).
   v2 changes: K.hnsw dropped (managed vector stores - Vertex AI Vector Search,
   AlloyDB - use ScaNN, so there are no HNSW tuning knobs or recall curves), the
   Elasticsearch vector store option is gone (the store is always managed), and
   the platform rates moved out of the v1 formulas into the PB / PRICE book below,
   verified against the official list prices on 2026-06-11 (v1 keeps its older
   inline copies; the two tools no longer share numbers). */
(function (NS) {
  'use strict';

  /* $/1M tokens for in/out/cacheRead; webSearch = $ per 1k web-search/grounding calls
     (0 = the model has no web search tool). ttftMs = time to first token at a
     few-k-token prompt (prefill included). msPerOutTok = PER-STREAM decode ms per
     output token (1000 / tok-per-sec as one request sees it, NOT server aggregate
     throughput): ~140 tok/s Pro-class, ~250 Flash, ~360 Flash-Lite, ~70 Opus-class,
     ~85 a self-hosted 70B-active on one node. Illustrative ~May 2026. */
  const MODELS = [
    { id: 'gemini-3-pro', name: 'Gemini 3 Pro', in: 2.0, out: 12.0, cacheRead: 0.20, webSearch: 14.0, ttftMs: 550, msPerOutTok: 7 },
    { id: 'gemini-35-flash', name: 'Gemini 3.5 Flash', in: 1.5, out: 9.0, cacheRead: 0.15, webSearch: 14.0, ttftMs: 400, msPerOutTok: 4 },
    { id: 'gemini-31-flash-lite', name: 'Gemini 3.1 Flash-Lite', in: 0.25, out: 1.5, cacheRead: 0.025, webSearch: 14.0, ttftMs: 180, msPerOutTok: 2.8 },
    { id: 'claude-opus-48', name: 'Claude Opus 4.8', in: 5.0, out: 25.0, cacheRead: 0.50, webSearch: 10.0, ttftMs: 600, msPerOutTok: 14 },
    { id: 'llama4-selfhost', name: 'Llama 4 (self-host)', in: 0, out: 0, cacheRead: 0, webSearch: 0, ttftMs: 500, msPerOutTok: 12 },
  ];
  const modelById = id => MODELS.find(m => m.id === id) || MODELS[0];

  const K = {
    /* chunksPerDoc is derived from the same document the parse line prices:
       docPages x tokensPerPage / tokensPerChunk = 40 x 600 / 500 = 48, so the
       index math and the Document AI math can never describe different corpora
       (the old 5-chunk constant implied a 4-page document while parsing billed 40). */
    dim: 768, chunksPerDoc: 48, bytesPerFloat: 4,
    /* CJK runs ~2-3 tokens per word vs ~1.3 for English: the same content costs
       roughly double the tokens, chunks on character boundaries, and needs
       native-language golden sets. Applied to corpus-derived ingestion math
       when ZH or JA is selected. */
    lang: { cjkIngestMult: 1.8, cjkLangs: ['zh', 'ja'] },
    apigeeRpsPerRegion: 30000, embedTokPerWorkerDay: 2.0e9,
    hoursMo: 730,
    /* Self-host fleet sizing. nodeTokPerSec = decode tok/s for a 70B-active model at
       FP8 on one 8-accelerator node. costHr is per 8-accelerator node ($/hr) per tier,
       from the accelerator-optimized VM and TPU list prices (verified 2026-06-11):
       h100 = a3-highgpu-8g; b200 = a4-highgpu-8t, which has no plain on-demand rate,
       so on_demand carries the DWS Flex-start rate; tpu = an 8-chip Ironwood host
       ($12/chip-hr on demand, $5.40 3-yr), whose spot rate is not published (the
       value here is an illustrative half of on-demand). */
    gpu: {
      nodeTokPerSec: 8000, baseActiveB: 70, refActiveB: 17, moePenalty: 0.5,
      precMult: { bf16: 1.0, fp8: 2.0, int4: 2.8 },
      accel: {
        h100: { tpsMult: 1.0, costHr: { on_demand: 88.49, cud_3y: 38.86, spot: 39.81 } },
        b200: { tpsMult: 2.2, costHr: { on_demand: 64.44, cud_3y: 56.71, spot: 34.24 } },
        tpu: { tpsMult: 1.3, costHr: { on_demand: 96.00, cud_3y: 43.20, spot: 48.00 } },
      },
    },
    bqScanMB: 50,
    /* Wire bytes per token, for egress, DLP inspection, and log-volume estimates. */
    net: { bytesPerTok: 4 },
    lat: { retrieval: 70, rerank: 80, bigqueryScan: 1200, webGround: 600, onpremCall: 400, qualityGate: 80, cacheExact: 5, cacheSem: 30,
      /* Multi-agent line items: the Orchestrator plans once (~planTok tokens, later
         hand-offs are function calls); the Validator reads the COMPLETE draft and
         writes a ~verdictTok-token critique (draft prefill rides inside its TTFT).
         vaisAnswerTok = the concise grounded answer Agent Search's bundled
         Flash-Lite-class answerer generates on the no-agent sub-second path. */
      planTok: 100, verdictTok: 150, vaisAnswerTok: 200 },
    /* Performance and capacity assumptions (illustrative, documented on the page):
       instConcurrency = concurrent streamed requests one agent instance holds open
       (agentic requests are I/O-bound on model calls); instMin = HA floor;
       stateOpsPerReq = session read + turn write + run-state write;
       vvsQpsPerNode = sustained ScaNN queries per serving node at moderate recall;
       ptTokMinThreshold = peak tokens/min past which dynamic shared quota is a
       p95 risk and Provisioned Throughput is the lever; linkSatPct = utilisation
       % past which the hybrid VLAN attachment needs a resize; stepSuccess = the
       assumed per-step success rate of an automation agent (task success
       compounds per step: 0.99^8 = 92%, 0.95^8 = 66%, which is why agents stay
       narrow); maxAgentSteps = the cap past which the compounding lint fires. */
    perf: { instConcurrency: 30, instMin: 2, stateOpsPerReq: 3, vvsQpsPerNode: 800, ptTokMinThreshold: 3e6, linkSatPct: 60, stepSuccess: 0.99, maxAgentSteps: 8 },
    /* Fixed ingestion assumptions (the original exposed these in a drill-down sub-calculator). */
    ingestion: { docsPerDayFactor: 0.002, docPages: 40, tokensPerPage: 600, tokensPerChunk: 500 },
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
  /* p95 budget (ms) per latency preset on the assistant path. LATENCY_BUDGET
     checks the full answer, LATENCY_BUDGET_START the first token of the final
     answer. Each tier's budget fits the architecture it derives:
     - subsecond (1s): the no-agent path - Agent Search's bundled grounded
       answer, no external agent, LLM call, or tool use (~0.85s worst path).
     - interactive (2s start / 5s full): one streaming single agent with
       grounding and tools (~1.5s start / ~4.1s full at the default workload).
     - agentic (10s start / 12s full): the validator-gated multi-agent team,
       which releases nothing until the validated draft clears the loop
       (start = full, ~9s at the default preset on realistic decode rates).
     Automation runs async (minutes), so it carries no interactive budget. */
  const LATENCY_BUDGET = { subsecond: 1000, interactive: 5000, agentic: 12000, minutes: Infinity };
  const LATENCY_BUDGET_START = { interactive: 2000, agentic: 10000 };

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
    EdgeGW: 'The request-side API gateway at the system edge: authenticates the caller (human users via Workforce Identity Federation against the corporate IdP; workloads via IAM + mTLS), enforces token-aware rate limits (tokens per minute, not requests per minute - one million-token request equals a thousand small ones), redacts inbound PII in two stages (fast regex, then Cloud DLP for named entities) before any model call, and screens for prompt injection and jailbreaks. For regulated or customer data the redaction stage fails closed: if it is slow or down, requests queue rather than bypass it. Implemented by Apigee, Cloud API Gateway, or a third-party gateway. Shows only the controls your inputs require. Sized on inbound user QPS.',
    Armor: 'Model Armor screens every model call inline: it filters prompt injection and jailbreaks on the way in and redacts or blocks unsafe or leaking output on the way out. It sees every model call, so it sizes on model-call QPS (user QPS x fan-out), not user QPS.',
    Orchestrator: 'Inside Agent compute: the dispatcher. It decomposes the request into steps, sends data fetching to the Retrieval agent, routes the draft between the Generator and the Validator, enforces the iteration cap on the revise loop, and composes the final answer. Agent hand-offs ride A2A; tools connect over MCP. Every hand-off returns here, so run state in the state store stays consistent and the whole flow is traceable.',
    Retriever: 'Inside Agent compute: the data-tool specialist. It executes the retrieval and live-data calls the Orchestrator dispatches (vector store, live sources, web grounding - tools connected over MCP) and returns the grounded context, keeping tool execution and tool-argument handling out of the Generator prompt.',
    Generator: 'Inside Agent compute: the drafting specialist. It calls the models through Model Armor, turns the context the Orchestrator hands it into a draft, and returns the draft to the Orchestrator. When the Validator rejects a draft, the Orchestrator re-invokes it with the critique (the generate-evaluate-revise loop).',
    GeneratorSingle: 'Inside Agent compute: the single agent. It plans the request, calls the models through Model Armor, reads retrieval, and produces the final answer in one pass - there is no separate orchestrator, retrieval agent, or validator critique loop.',
    Validator: 'Inside Agent compute: the automated quality gate. It evaluates the draft against the acceptance criteria and, on a fail, returns a revise verdict to the Orchestrator, which re-invokes the Generator with the critique; on a pass the answer is returned or sent for human review.',
    SecretMgr: 'Secret Manager holds the AUTH credential for the self-hosted Redis-on-GKE tier (the hot state tier and/or the response cache). Every other dependency authenticates through the agent service account via IAM / Workload Identity Federation, so no other secret is stored. Provisioned only when Redis on GKE is in the design.',
    KMS: 'Cloud KMS holds the customer-managed encryption key (CMEK). It encrypts the managed data-at-rest stores - Cloud Storage, the managed state store, the durable tier, the managed Memorystore cache - so data at rest is under a key you own. Self-hosted stores (Redis on GKE) use disk and application encryption instead.',
    Cache: 'A response cache on the request path: on a hit it returns a stored answer and skips the agent and model entirely. Exact-match keys on the normalized query; semantic match keys on the query embedding. Keys are namespaced per tenant, never global - a shared semantic cache can serve one tenant an answer generated from another tenant\'s context, a data leak by construction. Invalidation is TTL (set from data freshness) plus version busting (key namespaced by model, prompt, and index version).',
    Retr: 'Narrows candidates in stages: metadata pre-filter, then hybrid retrieval (dense + BM25 fused with reciprocal rank fusion, ~50 candidates - the keyword leg catches policy numbers and exact codes embeddings miss), then a cross-encoder reranker keeps the top ~5. The reranker is a named trade: ~80ms at p95 for roughly half the hallucination rate. The metadata pre-filter is also the entitlement gate: access-control principals ride on every chunk and filter BEFORE ranking, so the model never sees a forbidden chunk - it cannot leak what it never saw.',
    Sand: 'Runs PII-sensitive or untrusted tool execution in an ephemeral, isolated instance that is wiped after each use.',
    LLM: 'The reasoning and fast models. Smart routing sends easy lookups to the cheap model and hard queries to the reasoning model.',
    Store: 'The index that retrieval reads at query time. Managed (Agent Search, with ACL-aware search so per-user entitlements filter in the index, not the prompt) or self-built on a managed ScaNN-backed vector store (Vertex AI Vector Search or AlloyDB). Populated offline by the ingestion branch, never at request time. Answers are gated on a check-grounding score: below threshold, return the documents instead of asserting an answer.',
    Idx: 'The content indexed offline into the store: the document corpus and crawled company website pages. Re-crawled and re-embedded on a schedule, so the index is only as fresh as the last run.',
    GCS: 'Cloud Storage holds the source documents and the packaged agent artifact. It feeds the offline index; it is not read at request time.',
    Live: 'Sources queried live at request time (BigQuery text-to-SQL, on-prem DB, knowledge graph, streaming), not pre-indexed. Generated SQL passes three gates before it executes: catalog validation (hallucinated columns die before they run), a dry-run for syntax and bytes scanned, and an enforced partition filter plus maximum-bytes-billed cap; execution gets up to two self-repair retries on error, and every answer returns with the SQL, the row count, and the tables used - the trust architecture, not UX polish. Credentials are read-only and per-user (row-level security lives in the warehouse): the model proposes, the warehouse enforces, and the model only narrates a result set already filtered to the user.',
    WebG: 'Live web grounding via the model web-search tool (Gemini Google Search or Claude web search) for fresh, public, non-owned content. Billed per search; not available on self-hosted Llama.',
    DocAI: 'Parses source documents and pages into clean structured text (layout, tables, OCR) before chunking and embedding, and extracts entities that ride along as searchable metadata.',
    DLPDeid: 'Sensitive Data Protection (Cloud DLP) de-identifies the parsed documents BEFORE anything is embedded or indexed - otherwise raw PII flows into the vectors and the index, and every retrieved chunk can replay it. Agent Search has no built-in de-identification config, so the managed path imports from the de-identified output bucket of the native SDP Cloud Storage de-identify job, never the raw bucket. Scope it to the retrieval index only: an extraction pipeline\'s payload fields are exactly what de-identification strips. Crawled public website pages skip it.',
    Handoff: 'The human handoff for a customer-facing assistant, with the full conversation context attached so the customer never repeats themselves. The escalation rule: two failed turns, the user asks for a human, or confidence drops - immediate handoff; a conversation-level max-turns cap bounds the session as an absolute backstop. Track escalation correctness with equal weight to containment - containment bought by refusing to escalate is fake and shows up later as churn; never trap the user.',
    Emb: 'Splits parsed content into ~500-token chunks with heading context carried in (character-boundary chunking for CJK), embeds them, and writes the vectors plus a BM25 index into the managed vector store. The named what-fails-first risk is a re-index storm: an embedding model swap re-embeds the entire corpus because vector spaces do not mix - the separated ingestion plane absorbs that without touching query latency.',
    Obs: 'Traces, logs, and evals for every step - the audit answer is a replayable trace, end to end. Quality, latency, and cost stay measurable; regressions get caught. Alert on dead-letter-queue depth growth (it usually means an upstream format changed overnight) and on guard-hit rate (a rising rate means the process or the tools changed underneath the agent).',
    Appr: 'Confidence-gated human review (maker-checker or dual-control): irreversible actions (payments, customer communications, anything legal) and items whose business-critical fields miss their confidence thresholds queue here WITH the agent\'s full reasoning and trace attached; confident, reversible work flows straight through. Async: a queued run resumes on approval. Review staffing is the real cost - flag rate x volume x minutes per review - so the confidence threshold is a staffing-and-risk decision the business signs off, tuned per field, not an ML knob.',
    Fb: 'Captures thumbs and reasons from users and feeds them into the eval set, so quality does not silently decay.',
    Trig: 'The event that starts a run: a ticket, a webhook, or a scheduled job.',
    State: 'Transactional run and session state: automation checkpoints after EACH step, so a crashed case resumes instead of restarting. Default is AlloyDB: PostgreSQL-compatible, HA, with pgvector/ScaNN for agent memory, and cheaper than Spanner for a single region. Use Spanner for active-active multi-region writes. Per-case session memory is fine; cross-case long-term memory goes through human review before it becomes standing behavior, because a poisoned memory contaminates every future case. Durable audit and long-term event history belong in BigQuery.',
    StateDur: 'Durable tier paired with the hot Redis cache: AlloyDB (regional HA) by default, or Spanner (active-active multi-region writes) when the design needs them. Both are managed services reached over a Private Service Connect endpoint, so they live outside the dedicated VPC.',
    SemLayer: 'The semantic layer for text-to-SQL: schema, column descriptions, and the canonical metric definitions, supplied to the model as a cached prefix (~90% discount, so the big schema context is nearly free). Schema and column descriptions are the number-one accuracy predictor in this design, ahead of model choice - accuracy goes up when descriptions improve, with no model change. The metric dictionary is a readiness gate: agree the definitions with finance before launch, or the copilot industrializes the ambiguity.',
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
    'Cloud DLP (ingest de-identify)': 'components/cloud-dlp.html',
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

  /* Price book: billable list rates per component, verified against the official
     pricing pages on 2026-06-11 (us-central1 / US where regional). Workload
     assumptions that feed a single line (spansPerReq, samplePct, msgKB) live next
     to their rate; cross-line assumptions (bytes/token, scan MB/req) stay in K.
     Anything not on a list price is marked illustrative in its why text. */
  const PB = {
    runtime: { baseMo: 40, vcpuHr: 0.0864, gibHr: 0.009, vcpuSecPerReq: 20, gibSecPerReq: 40 },
    lgInfra: { baseMo: 850, perNodeMo: 150, perReq: 0.0004 },
    lgLicense: { mo: 5000 },
    apigee: { envMo: 365, perMCalls: 20 },
    apigw: { perMCalls: 3, freeMCalls: 2 },
    logging: { ingestPerGiB: 0.50, freeGiB: 50, retainPerGiBMo: 0.01, retainMo: 36, logBytesPerTok: 12, baseMo: 5 },
    audit: { entriesPerReq: 20, kibPerEntry: 1, perGiB: 0.50, baseMo: 5 },
    vvs: { nodeHr: 0.7504672, nodeType: 'e2-standard-16', shardGB: 50 },
    vais: { per1kQueries: 4.0, std1kQueries: 1.5, storageGiB: 5, freeGiB: 10, websiteBase: 30 },
    alloy: { vcpuHr: 0.06608, gibHr: 0.0112, baseVcpu: 2, baseGiB: 16, poolVcpu: 1, poolGiB: 8, storagePerGB: 0.30 },
    dataflow: { baseMo: 30, perDoc: 0.02 },
    /* Classify-first parser routing: born-digital text is nearly free, only the
       complex-layout share pays the Layout Parser rate, the rest rides OCR. */
    docai: { perPageOcr: 0.0015, perPageLayout: 0.01, complexShare: 0.1 },
    bq: { scanPerTiB: 6.25, scanFreeTiB: 1, storedGB: 200, storeFreeGB: 10, storePerGB: 0.02 },
    spanner: { nodeHr: 0.72, storagePerGB: 0.30 },
    cloudsql: { baseMo: 202, replicaMo: 101 },
    redis: { nodeHr: 0.0318, nodes: 3 },
    gke: { clusterFeeMo: 73, vcpuHr: 0.0445, gibHr: 0.0049225, baseVcpu: 1.5, baseGib: 3, perNodeVcpu: 0.5, perNodeGib: 1 },
    gcs: { perGB: 0.02, baseGB: 250 },
    secrets: { versionMo: 0.06, versions: 10, accessMo: 0.4 },
    kms: { keyVersionMo: 0.06, keyVersions: 20, per10kOps: 0.03, opsPerReq: 0.1 },
    pubsub: { perTiB: 40, msgKB: 10, baseMo: 10 },
    trace: { perMSpans: 0.20, freeMSpans: 2.5, spansPerReq: 30 },
    evals: { samplePct: 5, perEval: 0.0012 },
    armor: { perMTok: 0.10, freeMTok: 2, screenMult: 2 },
    dlp: { perGB: 3.0, freeGB: 1 },
    dlpDeid: { perGB: 1.0, freeGB: 1 },
    egress: { perGB: 0.12, freeGB: 1 },
    icx: { vlanHr: 0.2778, vlanGbps: 1, perGB: 0.02 },
    embed: { perMTok: 0.15, batchPerMTok: 0.10 },
    labor: { ftePerMo: 18000, gkeFte: 0.5, gpuNodesPerFte: 8, gpuMinFte: 0.5, langgraphFte: 0.5 },
    support: { minMo: 100, tiers: [[10000, 0.10], [80000, 0.07], [250000, 0.05], [Infinity, 0.03]] },
  };

  /* Static text and reference link per cost line. The note is the short tag on the
     row; the why is the assumption explainer (hover + expanded detail); the ref is
     the official pricing page. The substituted formula (calc) is built next to the
     math in asd2-metrics.js so the string can never drift from the number. */
  const PRICE = {
    'ADK + Agent Runtime': {
      rates: PB.runtime, ref: 'https://cloud.google.com/vertex-ai/pricing',
      note: 'managed runtime bundled',
      why: `Agent Runtime bills $${PB.runtime.vcpuHr}/vCPU-hr + $${PB.runtime.gibHr}/GiB-hr; the per-request charge assumes ~${PB.runtime.vcpuSecPerReq} vCPU-s and ${PB.runtime.gibSecPerReq} GiB-s of billed runtime per agentic request, plus a $${PB.runtime.baseMo}/mo baseline footprint. Sessions, state, autoscaling, and tracing are bundled, so there is no separate ops line; the ADK framework itself is open source.`,
    },
    'Agent Studio': {
      rates: PB.runtime, ref: 'https://cloud.google.com/vertex-ai/pricing',
      note: 'managed runtime bundled',
      why: `Runs on the same managed Agent Runtime: $${PB.runtime.vcpuHr}/vCPU-hr + $${PB.runtime.gibHr}/GiB-hr, assuming ~${PB.runtime.vcpuSecPerReq} vCPU-s and ${PB.runtime.gibSecPerReq} GiB-s per request plus a $${PB.runtime.baseMo}/mo baseline. Sessions, state, autoscaling, and tracing are bundled.`,
    },
    'LangGraph': {
      rates: {}, ref: 'https://www.langchain.com/pricing',
      note: 'framework only (free OSS)',
      why: 'The LangGraph library is open source (MIT), so the framework itself is free. The compute that runs it, plus storage and monitoring, is the Self-managed infra + ops line; the supported self-hosted path also needs the LangGraph Platform Enterprise line.',
    },
    'Self-managed infra + ops (LangGraph)': {
      rates: PB.lgInfra, ref: 'https://www.langchain.com/pricing',
      note: 'K8s + Postgres + Redis + monitoring',
      why: `Illustrative floor for running LangGraph yourself: a Kubernetes cluster, a PostgreSQL checkpoint store, Redis for streaming, and self-hosted monitoring ($${PB.lgInfra.baseMo}/mo, plus $${PB.lgInfra.perNodeMo} per concurrency node and $${PB.lgInfra.perReq} per run). Ops and on-call labor is the separate Ops & on-call labor line below the total.`,
    },
    'LangGraph Platform Enterprise (self-host license)': {
      rates: PB.lgLicense, ref: 'https://www.langchain.com/pricing',
      note: 'custom, ~$2k-5k/mo (illustrative $5k)',
      why: 'Self-hosting LangGraph is a LangGraph Platform / LangSmith Enterprise add-on. Pricing is custom and not published; third-party estimates put mid-size contracts around $2,000 to $5,000 per month. Contact LangChain sales for a real quote.',
    },
    'Apigee': {
      rates: PB.apigee, ref: 'https://cloud.google.com/apigee/pricing',
      note: 'PAYG env + $/M calls',
      why: `Apigee pay-as-you-go: one Base environment at $${PB.apigee.envMo}/mo per region (50 QPS cap, Standard proxies) plus $${PB.apigee.perMCalls}/M Standard API proxy calls in the first 50M tier. Intermediate ($1,460/mo) or Comprehensive ($3,431/mo) environments raise the floor.`,
    },
    'Cloud IAP': {
      free: true, ref: 'https://cloud.google.com/iap/pricing',
      note: 'no charge',
      why: 'Identity-Aware Proxy has no per-request price when protecting Google Cloud resources; you pay only for the load balancer and backends behind it.',
    },
    'Cloud API Gateway': {
      rates: PB.apigw, ref: 'https://cloud.google.com/api-gateway/pricing',
      note: `free under ${PB.apigw.freeMCalls}M calls/mo`,
      why: `$${PB.apigw.perMCalls} per million API calls between ${PB.apigw.freeMCalls}M and 1B per month; the first ${PB.apigw.freeMCalls}M calls each month are free, so small workloads ride the free tier entirely.`,
    },
    'Cloud Logging (WORM)': {
      rates: PB.logging, ref: 'https://cloud.google.com/stackdriver/pricing',
      note: 'app + model logs, WORM hold',
      why: `Logging ingestion at $${PB.logging.ingestPerGiB}/GiB past the ${PB.logging.freeGiB} GiB/project/mo free tier, assuming ~${PB.logging.logBytesPerTok} logged bytes per token (structured request, model-call, and response records). The WORM compliance hold keeps each GiB ${PB.logging.retainMo} months at $${PB.logging.retainPerGiBMo}/GiB-mo past the included 30 days, plus $${PB.logging.baseMo}/mo of system logs. The log bucket sits under CMEK at regulated tiers, and when the edge redacts prompts, the pre-redaction originals are retained here encrypted under a separate key from the application data.`,
    },
    'Cloud Audit Logs (Data Access)': {
      rates: PB.audit, ref: 'https://cloud.google.com/stackdriver/pricing',
      note: 'Data Access stream only',
      why: `Only the Data Access audit stream is billed, as standard Logging ingestion at $${PB.audit.perGiB}/GiB; assumes ~${PB.audit.entriesPerReq} data-access entries of ~${PB.audit.kibPerEntry} KiB per request across the managed stores. Admin Activity, System Event, and Policy Denied logs are always on and free.`,
    },
    'Vector Search': {
      rates: PB.vvs, ref: 'https://cloud.google.com/vertex-ai/pricing',
      note: 'dedicated serving nodes',
      why: `Dedicated ScaNN serving nodes: ${PB.vvs.nodeType} at $${PB.vvs.nodeHr}/node-hr, one node per ~${PB.vvs.shardGB} GB of index. Index build ($3/GiB processed) and streaming writes are excluded as minor next to serving.`,
    },
    'Agent Search': {
      rates: PB.vais, ref: 'https://cloud.google.com/generative-ai-app-builder/pricing',
      note: 'Enterprise edition queries',
      why: `Agent Search Enterprise at $${PB.vais.per1kQueries}/1k queries with generative answers included (Standard is $${PB.vais.std1kQueries}/1k without), plus index storage at $${PB.vais.storageGiB}/GiB-mo past the ${PB.vais.freeGiB} GiB free tier. A crawled website data store adds ~$${PB.vais.websiteBase}/mo (~6 GiB of pages metered at 500 KiB/page).`,
    },
    'AlloyDB': {
      rates: PB.alloy, ref: 'https://cloud.google.com/alloydb/pricing',
      note: `${PB.alloy.baseVcpu} vCPU / ${PB.alloy.baseGiB} GiB primary`,
      why: `A ${PB.alloy.baseVcpu} vCPU / ${PB.alloy.baseGiB} GiB regional primary at $${PB.alloy.vcpuHr}/vCPU-hr + $${PB.alloy.gibHr}/GiB-hr, plus cluster storage at $${PB.alloy.storagePerGB}/GB-mo for the index. AlloyDB serves the vectors through the pgvector + ScaNN extension.`,
    },
    'AlloyDB (state)': {
      rates: PB.alloy, ref: 'https://cloud.google.com/alloydb/pricing',
      note: 'primary + read pool',
      why: `A ${PB.alloy.baseVcpu} vCPU / ${PB.alloy.baseGiB} GiB regional primary at $${PB.alloy.vcpuHr}/vCPU-hr + $${PB.alloy.gibHr}/GiB-hr, plus one ${PB.alloy.poolVcpu} vCPU / ${PB.alloy.poolGiB} GiB read-pool node per ~100 peak QPS and storage at $${PB.alloy.storagePerGB}/GB-mo.`,
    },
    'BM25': {
      free: true,
      note: 'bundled with the store',
      why: 'The sparse BM25 index rides the vector store; there is no separate SKU.',
    },
    'Dataflow': {
      rates: PB.dataflow, ref: 'https://cloud.google.com/dataflow/pricing',
      note: 'incremental ingestion',
      why: `An illustrative incremental-ingestion floor of $${PB.dataflow.baseMo}/mo (a small daily batch at $0.056/vCPU-hr + $0.003557/GiB-hr) plus $${PB.dataflow.perDoc} per changed document parsed and embedded; assumes ${K.ingestion.docsPerDayFactor * 100}% of the corpus changes per day.`,
    },
    'Document AI': {
      rates: PB.docai, ref: 'https://cloud.google.com/document-ai/pricing',
      note: 'classify first, pay per class',
      why: `Classify-first parser routing: a cheap classifier stage routes born-digital documents to near-free text extraction, only the complex-layout share (~${PB.docai.complexShare * 100}%) pays Layout Parser at $${PB.docai.perPageLayout * 1000}/1k pages, and the rest rides Enterprise Document OCR at $${PB.docai.perPageOcr * 1000}/1k pages - never pay the layout rate for documents that do not need it. Hopeless scans are quality-gated on OCR confidence and route to a human rather than letting the model hallucinate a blurry number. ~${K.ingestion.docPages} pages per changed document.`,
    },
    'BigQuery': {
      rates: PB.bq, ref: 'https://cloud.google.com/bigquery/pricing',
      note: `~${K.bqScanMB} MB scanned/req`,
      why: `On-demand BigQuery at $${PB.bq.scanPerTiB}/TiB scanned after the ${PB.bq.scanFreeTiB} TiB/mo free tier, assuming ~${K.bqScanMB} MB per request, plus ~${PB.bq.storedGB} GB stored at $${PB.bq.storePerGB}/GB-mo past the ${PB.bq.storeFreeGB} GB free. Partitioning and clustering can push the scan well below this illustrative figure.`,
    },
    'Spanner': {
      rates: PB.spanner, ref: 'https://cloud.google.com/spanner/pricing',
      note: 'Standard edition nodes',
      why: `Spanner Standard edition at $${PB.spanner.nodeHr}/node-hr (about $${Math.round(PB.spanner.nodeHr * K.hoursMo)}/node-mo, all three replicas included), one node per ~100 peak QPS, plus SSD storage at $${PB.spanner.storagePerGB}/GiB-mo.`,
    },
    'Cloud SQL': {
      rates: PB.cloudsql, ref: 'https://cloud.google.com/sql/pricing',
      note: 'HA primary + replicas',
      why: `Enterprise edition HA primary (2 vCPU / 8 GiB at $0.2772/hr, about $${PB.cloudsql.baseMo}/mo) plus one non-HA read replica (~$${PB.cloudsql.replicaMo}/mo) per ~100 peak QPS.`,
    },
    'Memorystore Cluster': {
      rates: PB.redis, ref: 'https://cloud.google.com/memorystore/docs/cluster/pricing',
      note: `${PB.redis.nodes}-node minimum cluster`,
      why: `Memorystore for Redis Cluster: ${PB.redis.nodes} x redis-shared-core-nano nodes (1.4 GB each) at $${PB.redis.nodeHr}/node-hr, the smallest resilient footprint for the hot state tier and response cache.`,
    },
    'GKE Autopilot (agent)': {
      rates: PB.gke, ref: 'https://cloud.google.com/kubernetes-engine/pricing',
      note: 'cluster fee + agent pods',
      why: `Autopilot cluster fee of $0.10/hr (~$${PB.gke.clusterFeeMo}/mo) plus ~${PB.gke.baseVcpu} vCPU and ${PB.gke.baseGib} GiB of always-on agent pods at $${PB.gke.vcpuHr}/vCPU-hr + $${PB.gke.gibHr}/GiB-hr, plus one ${PB.gke.perNodeVcpu} vCPU burst pod per ~100 peak QPS.`,
    },
    'Cloud Storage': {
      rates: PB.gcs, ref: 'https://cloud.google.com/storage/pricing',
      note: 'docs + artifacts + index',
      why: `Standard storage at $${PB.gcs.perGB}/GB-mo: ~${PB.gcs.baseGB} GB of source documents and agent artifacts plus the serialized index. Regulated documents usually pin the region and start a deletion clock - set bucket retention and lifecycle policies to match (for example seven-year retention on medical records, then deletion).`,
    },
    'Secret Manager': {
      rates: PB.secrets, ref: 'https://cloud.google.com/secret-manager/pricing',
      note: 'Redis AUTH versions',
      why: `$${PB.secrets.versionMo}/secret-version-mo for ~${PB.secrets.versions} active versions (the Redis AUTH credential and its rotations) plus access operations at $0.03/10k; reads are cached at pod startup.`,
    },
    'Cloud KMS': {
      rates: PB.kms, ref: 'https://cloud.google.com/kms/pricing',
      note: 'CMEK keys, DEKs cached',
      why: `${PB.kms.keyVersions} active key versions at $${PB.kms.keyVersionMo}/mo each, plus crypto operations at $${PB.kms.per10kOps}/10k. Envelope encryption caches data keys, so operations run ~${PB.kms.opsPerReq} per request, not one per request.`,
    },
    'Pub/Sub': {
      rates: PB.pubsub, ref: 'https://cloud.google.com/pubsub/pricing',
      note: `~${PB.pubsub.msgKB} KiB / message`,
      why: `Throughput at $${PB.pubsub.perTiB}/TiB (publish + subscribe), assuming one ~${PB.pubsub.msgKB} KiB trigger message per run, plus a $${PB.pubsub.baseMo}/mo floor for topics and dead-letter handling. Pub/Sub is the shock absorber for volume spikes; delivery is at-least-once, so side effects key on the work-item hash (a replay can never double-process), and DLQ depth growth is an alert, because it usually means an upstream format changed overnight.`,
    },
    'Cloud Trace': {
      rates: PB.trace, ref: 'https://cloud.google.com/stackdriver/pricing',
      note: `~${PB.trace.spansPerReq} spans/req`,
      why: `$${PB.trace.perMSpans} per million spans past the ${PB.trace.freeMSpans}M/mo free tier; an agentic request emits ~${PB.trace.spansPerReq} spans across the gateway, agent steps, model calls, and retrieval.`,
    },
    'Agent Platform Evals': {
      rates: PB.evals, ref: 'https://cloud.google.com/vertex-ai/pricing',
      note: `${PB.evals.samplePct}% sampled`,
      why: `Continuous evals on a ${PB.evals.samplePct}% sample at ~$${PB.evals.perEval} per evaluated response: model-based metrics bill the autorater judge tokens (a Flash-Lite-class judge reading ~3k tokens and writing ~300 per eval). What the sample checks: faithfulness with a version-pinned judge, citation validity when a corpus is indexed (the link resolves AND supports the sentence), per-class slices (an aggregate score hides the one class that is failing), and confidence calibration when review is confidence-gated (when the model says 90%, is it right 90% of the time). Safety stages get their own gates: redaction recall on a seeded synthetic-PII corpus, an injection suite on every Model Armor config change, cache-isolation tests, and tool-schema contract tests that rerun the suite on every schema change.`,
    },
    'Model Armor': {
      rates: PB.armor, ref: 'https://cloud.google.com/security-command-center/pricing',
      note: 'screens prompts + responses',
      why: `$${PB.armor.perMTok}/M screened tokens past the ${PB.armor.freeMTok}M/mo free tier. Prompts and responses are both screened, so screened volume runs ~${PB.armor.screenMult}x the billed token volume; Model Armor sizes on model-call traffic, not user QPS.`,
    },
    'Workload Identity': {
      free: true,
      note: 'no charge',
      why: 'Workload Identity Federation has no charge; tool authorization rides IAM. Tool calls are classified read vs write: reads are free, writes carry idempotency keys so a retried call can never double-commit. Live account-data tools execute with the END-USER\'s authenticated identity flowing through (a customer can only ever read their own records), not a service account that sees everything; human callers authenticate via Workforce Identity Federation against the corporate IdP.',
    },
    'Model Registry': {
      free: true,
      note: 'no charge',
      why: 'Model Registry itself is free; you pay only for deployed endpoints, which are priced on their own lines.',
    },
    'VPC Service Controls': {
      free: true,
      note: 'no charge',
      why: 'VPC Service Controls perimeters have no direct charge.',
    },
    'Cloud DLP': {
      rates: PB.dlp, ref: 'https://cloud.google.com/sensitive-data-protection/pricing',
      note: 'content inspection $/GB',
      why: `Sensitive Data Protection content inspection at $${PB.dlp.perGB}/GB past the ${PB.dlp.freeGB} GB/mo free tier ($2/GB beyond 1 TB), on prompt + response bytes at ~${K.net.bytesPerTok} bytes/token. Inspection templates and sampling cut this further; the 1 KB per-request billing minimum is negligible at these payload sizes.`,
    },
    'Cloud DLP (ingest de-identify)': {
      rates: PB.dlpDeid, ref: 'https://cloud.google.com/sensitive-data-protection/pricing',
      note: 'de-identify before embedding',
      why: `Sensitive Data Protection storage de-identification (the native Cloud Storage de-identify job: an inspection job with a Deidentify action writing de-identified copies to an output bucket) at $${PB.dlpDeid.perGB}/GB up to 50 TB/mo, run on documents BEFORE chunking and embedding, so PII never enters the vectors or the index. Agent Search has no built-in de-identification configuration, so the managed path imports from the de-identified bucket, never the raw one. The content-method alternative (the Dataflow pipeline) bills inspection ($3/GB) plus transformation ($2/GB) separately. Sized on the daily refresh share; the one-time backfill is shown in the detail and kept out of the monthly total.`,
    },
    'IAM': {
      free: true,
      note: 'no charge',
      why: 'IAM policies and service accounts are free.',
    },
    'vLLM on GKE': {
      rates: PB.gke, ref: 'https://cloud.google.com/kubernetes-engine/pricing',
      note: 'cluster fee only',
      why: 'The vLLM serving layer is open source; this line is the GKE Autopilot cluster fee ($0.10/hr). The GPU node-hours themselves are the GPU fleet line under GenAI.',
    },
    'Cloud Interconnect + VLAN': {
      rates: PB.icx, ref: 'https://cloud.google.com/network-connectivity/docs/interconnect/pricing',
      note: `${PB.icx.vlanGbps} Gbps Partner VLAN`,
      why: `A ${PB.icx.vlanGbps} Gbps Partner Interconnect VLAN attachment at $${PB.icx.vlanHr}/hr (about $${Math.round(PB.icx.vlanHr * K.hoursMo)}/mo) plus egress over the link at $${PB.icx.perGB}/GiB. Assumes the physical interconnect to the partner already exists; a new Dedicated 10 Gbps port adds ~$1,700/mo.`,
    },
    'Network egress (internet)': {
      rates: PB.egress, ref: 'https://cloud.google.com/vpc/network-pricing',
      note: 'response bytes, Premium tier',
      why: `Internet egress on the Premium tier at $${PB.egress.perGB}/GiB (first ${PB.egress.freeGB} GiB free): response tokens x ${K.net.bytesPerTok} bytes. Token responses are small, so this line mostly proves egress is negligible here; bulk file delivery would change that.`,
    },
    'Embeddings (ingestion)': {
      rates: PB.embed, ref: 'https://cloud.google.com/vertex-ai/generative-ai/pricing',
      note: 'gemini-embedding refresh',
      why: `gemini-embedding at $${PB.embed.perMTok}/M input tokens on the re-embedded share of the corpus (${K.ingestion.docsPerDayFactor * 100}% of docs change per day, ${K.chunksPerDoc} chunks x ${K.ingestion.tokensPerChunk} tokens each). The one-time full backfill is priced at the $${PB.embed.batchPerMTok}/M batch tier (latency-tolerant by definition), shown in the detail but not added to the monthly total - quote it up front, because an embedding model swap re-runs it in full: vector spaces do not mix, so a model change is a whole-corpus re-index. Agent Search bundles embedding, so this line appears only on the self-built pipeline.`,
    },
    'Ops & on-call labor (build vs buy)': {
      rates: PB.labor,
      note: 'illustrative FTE fractions',
      why: `The opportunity cost of self-managing, at $${PB.labor.ftePerMo.toLocaleString('en-US')}/mo per fully loaded FTE (salary, benefits, overhead): ${PB.labor.gkeFte} FTE for GKE platform ops, max(${PB.labor.gpuMinFte}, fleet nodes / ${PB.labor.gpuNodesPerFte}) FTE for a self-hosted inference fleet, ${PB.labor.langgraphFte} FTE for self-managed LangGraph. Fully managed designs carry none. Illustrative, and not a GCP charge.`,
    },
    'Enterprise support (Enhanced)': {
      rates: PB.support, ref: 'https://cloud.google.com/support',
      note: `min $${PB.support.minMo} or % of spend`,
      why: `Google Cloud Customer Care, Enhanced tier: the greater of $${PB.support.minMo}/mo or tiered percentages of monthly spend (10% of the first $10k, 7% to $80k, 5% to $250k, 3% above). Premium starts at $15k/mo. Computed on the run-rate above; production systems should not run on Standard support.`,
    },
  };

  /* Static text and reference link for the GenAI and total rows; their calc
     strings are built in asd2-metrics.js compute() next to the token math. */
  const GENAI_REF = 'https://cloud.google.com/vertex-ai/generative-ai/pricing';
  const GENAI_PRICE = {
    fresh: { ref: GENAI_REF, why: 'Fresh input tokens at the model list $/M input rate, blended across the smart-routing split.' },
    cached: { ref: GENAI_REF, why: 'The repeated prompt prefix is served from context cache and billed at the model cache-read rate, roughly 10% of the fresh input rate.' },
    output: { ref: GENAI_REF, why: 'Output tokens at the model list $/M output rate, blended across the smart-routing split.' },
    grounding: { ref: GENAI_REF, why: 'Web grounding billed per search call: Gemini 3 models bill $14/1k search queries (5k/mo free), Claude web search bills $10/1k. Assumes one search per billed request.' },
    genai: { why: 'Fresh + cached + output + grounding for the billed (cache-miss) request volume.' },
    naive: { why: 'What the same volume costs on the reasoning model alone with no context cache, response cache, or smart routing; the baseline the optimizations are measured against.' },
    saved: { why: 'Naive baseline minus the optimized GenAI subtotal.' },
    gpu: { ref: 'https://cloud.google.com/products/compute/pricing/accelerator-optimized', why: 'Self-host fleet at the per-node $/hr for the chosen accelerator and pricing tier, 730 hr/mo, sized on peak output tokens/s at the configured utilization.' },
    plat: { why: 'Sum of the priced platform lines; unpriced lines are flagged and excluded.' },
    total: { why: 'GenAI (managed tokens + GPU fleet) plus the priced platform lines: the monthly GCP invoice estimate.' },
    perK: { why: 'Total run-rate divided by monthly requests, per 1k requests. Below-the-line items are excluded.' },
  };

  /* Formatting helpers shared by the metrics, render, and self-test modules. */
  const fmt = (n, d = 0) => { if (n == null || isNaN(n)) return '-'; const a = Math.abs(n); if (a >= 1e9) return (n / 1e9).toFixed(d || 1) + 'B'; if (a >= 1e6) return (n / 1e6).toFixed(d || 1) + 'M'; if (a >= 1e3) return (n / 1e3).toFixed(d || 1) + 'k'; return n.toFixed(d); };
  const money = n => { if (n == null || isNaN(n)) return '-'; return '$' + Math.round(n).toLocaleString('en-US'); };
  /* Plain thousands-separated number for the calc strings ('304,000', '14.5'). */
  const nfmt = (n, d = 0) => (n == null || isNaN(n)) ? '-' : (+n).toLocaleString('en-US', { maximumFractionDigits: d });

  NS.catalog = {
    MODELS, modelById, K, DIAGRAM_PALETTE,
    SRC_LABEL, INDEXED_SRC, LIVE_SRC, INDEXED_LABEL, LATENCY_HEAVY, LATENCY_BUDGET, LATENCY_BUDGET_START,
    STATE_STORE_LABEL, IN_LAT, OUT_LAT, LIGHT_AUTH, SENS,
    NODE_PURPOSE, DATA_SOURCE_ROLE,
    COMPONENT_DOC, MODEL_DOC, DS_COMPONENT, docFor, PRICE, GENAI_PRICE,
    fmt, money, nfmt,
  };
})(typeof window !== 'undefined' ? (window.ASD2 = window.ASD2 || {}) : (globalThis.ASD2 = globalThis.ASD2 || {}));
