/* Agentic System Designer v2 - Terraform bundle generator.
   generate(arch, inputs) -> { files, placeholders, steps }
   Pure function of the derived design: arch is the same object the diagram, BoM,
   and cost panel read, so the bundle cannot drift from what the page shows.
   No DOM, no network. zip(files) returns a store-only Uint8Array.

   The placeholders and steps lists are the single source of truth for everything
   the user must supply or do by hand: terraform.tfvars comments, the README
   "Before you apply" / "After apply" sections, the inline HCL comments, and the
   post-export UI checklist all render from them.

   v2 invariants honoured here (delta vs the old tf-generator.js):
   - No Elasticsearch / HNSW: the self-built path uses managed ScaNN stores only
     (Vertex AI Vector Search or the AlloyDB ScaNN index).
   - Hybrid is private-only ingress: no public API gateway; Cloud Run ingress is
     internal, the GKE LoadBalancer is internal, and the bridge rides tfvars.
   - The dedicated VPC wraps self-hosted compute only; managed stores are reached
     over Private Service Connect endpoints.
   - Secret Manager exists only for Redis-on-GKE AUTH; everything else is IAM/WIF.
   - CMEK covers managed stores only.
   - Agent Runtime objects are pushed with the ADK CLI (an after-apply step), not
     emitted as fragile Terraform.

   Style constraint: plain ASCII only in everything this file emits. */
(function (NS) {
  'use strict';

  /* Catalog model id -> deployable Vertex model id. Generator-owned data that
     drifts with model launches; surfaced as a README note so users verify it. */
  var MODEL_MAP = {
    'gemini-3-pro': 'gemini-3-pro',
    'gemini-35-flash': 'gemini-3.5-flash',
    'gemini-31-flash-lite': 'gemini-3.1-flash-lite',
    'claude-opus-48': 'claude-opus-4-8',
    'llama4-selfhost': 'llama-4'
  };
  function realModel(id) { return MODEL_MAP[id] || id || 'gemini-3.5-flash'; }

  function q(s) { return '"' + String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'; }

  /* ---------- derived emission context: every flag the emitters branch on ---------- */
  function ctx(arch, inputs) {
    var a = arch, i = inputs || {};
    var ds = i.dataSources || [];
    var c = {};
    c.purpose = a.purpose;
    c.automation = a.purpose === 'automation';
    c.gke = !!a.agent.gke;
    c.runtime = a.agent.runtime;
    c.pattern = a.agent.pattern;
    c.numAgents = a.agent.numAgents;
    c.reactMaxIter = a.agent.reactMaxIter;
    c.hybrid = !!a.topology.hybridLink;
    c.privateOnly = !!a.topology.privateOnly;
    c.vpc = !!a.topology.vpcDrawn;
    c.multiRegion = !!a.topology.multiRegion;
    c.gateway = !!a.gov.gateway;
    /* The public API gateway fronts the Cloud Run agent only; hybrid is
       private-only ingress and GKE designs enter through the (internal) LB. */
    c.publicGateway = c.gateway && !c.privateOnly && c.runtime === 'agentengine';
    c.vais = !!(a.retrieval.storeDrawn && a.retrieval.ragEngine === 'vais');
    c.selfbuilt = !!(a.retrieval.storeDrawn && a.retrieval.selfbuilt);
    c.vectorVertex = c.selfbuilt && a.retrieval.vectorDB === 'vertex';
    c.vectorAlloy = c.selfbuilt && a.retrieval.vectorDB === 'alloydb';
    c.ingestionSep = !!a.retrieval.ingestionSep;
    c.docCorpus = ds.indexOf('doc_corpus') >= 0;
    c.website = ds.indexOf('website') >= 0;
    c.bigquerySrc = ds.indexOf('bigquery') >= 0;
    c.streamSrc = ds.indexOf('stream') >= 0;
    c.store = a.state.store;
    c.stateAlloy = c.store.indexOf('alloydb') >= 0;
    c.stateSpanner = c.store.indexOf('spanner') >= 0;
    c.stateCloudSql = c.store === 'cloudsql';
    c.redisTier = !!a.state.redisTier;
    c.redisSelf = !!a.state.redisSelf;
    c.redisOnGke = !!a.state.redisOnGke;
    c.redisManaged = (c.redisTier && !c.redisSelf) || (!!a.caching.responseCacheOn && !c.gke);
    c.alloyAny = c.stateAlloy || c.vectorAlloy;
    c.cmek = !!a.security.cmek;
    c.vpcsc = !!a.security.enforceVpcSc;
    c.secretManagerOn = !!a.security.secretManagerOn;
    c.armor = !!a.models.armorOn;
    c.auditLog = !!a.gov.auditLog;
    c.dataAccessAudit = !!a.security.dataAccessAudit;
    c.residencyPin = !!a.gov.residencyPin;
    c.hitl = !!(a.gov.hitlApproval && a.gov.hitlApproval !== 'none');
    c.selfHost = !!a.models.selfHostAny;
    c.accelerator = a.sizing.accelerator;
    c.reasoningModel = realModel(a.models.reasoningModel);
    c.fastModel = realModel(a.models.fastModel);
    c.claude = /claude/.test(String(a.models.reasoningModel) + String(a.models.fastModel));
    /* The no-agent path: Agent Search answers directly, so there is no agent
       compute, model leg, Model Armor, run-state store, or self-host fleet to
       provision; conflicted live sources are not provisioned either. */
    c.answerOnly = !!a.agent.answerOnly;
    if (c.answerOnly) {
      c.gke = false; c.runtime = 'none'; c.pattern = 'none';
      c.publicGateway = false;
      c.stateAlloy = false; c.stateSpanner = false; c.stateCloudSql = false;
      c.redisTier = false; c.redisSelf = false; c.redisOnGke = false;
      c.redisManaged = !!a.caching.responseCacheOn;
      c.armor = false; c.selfHost = false; c.secretManagerOn = false; c.claude = false;
      c.vectorVertex = false; c.vectorAlloy = false; c.selfbuilt = false; c.alloyAny = false;
      c.bigquerySrc = false; c.streamSrc = false;
    }
    c.docai = c.selfbuilt && (c.docCorpus || c.website);
    c.dlpDeid = !!(a.retrieval && a.retrieval.dlpDeidIngest);
    c.pscStores = c.alloyAny || c.stateCloudSql || c.redisManaged;
    c.networkUser = c.pscStores || c.gke || c.selfHost || c.hybrid;
    /* Sizing defaults, derived the same way the metrics panel does (documented in
       the page sources): avg QPS over the active window, peak = avg x burst. */
    var avgQps = ((i.actors || 0) * (i.actionsPerDay || 0)) / (((i.activeHoursPerWeek || 50) * 3600) / 7);
    c.peakQps = Math.max(1, Math.ceil(avgQps * (i.burst || 1)));
    c.alloyCpu = c.peakQps > 100 ? 4 : 2;
    c.spannerPU = Math.max(1, Math.ceil(c.peakQps / 100)) * 1000;
    c.redisShards = 1;
    c.gpuNodes = 1;
    return c;
  }

  function netName(c) { return c.vpc ? 'google_compute_network.vpc.id' : '"default"'; }
  function netRef(c) { return c.vpc ? 'google_compute_network.vpc.id' : '"projects/${var.project_id}/global/networks/default"'; }

  /* ---------- placeholders: every value the user must supply ----------
     kind: 'required' (no default, plan stops), 'gated' (empty default disables
     the feature, count-gated), 'review' (safe default, replace before real use). */
  function placeholdersFor(c) {
    var P = [];
    var add = function (v, kind, why, whereToGet, gatesWhat) {
      P.push({ var: v, kind: kind, why: why, whereToGet: whereToGet, gatesWhat: gatesWhat || '' });
    };
    add('project_id', 'required', 'Target Google Cloud project id. No default on purpose: terraform plan stops until it is set.', 'gcloud projects list', 'everything');
    add('region', c.residencyPin ? 'required' : 'review',
      c.residencyPin ? 'This design pins data residency, so the region choice is a compliance decision, not a default.' : 'Primary region for regional resources. The default works; change it to be closer to your users.',
      'gcloud compute regions list', '');
    add('name_prefix', 'review', 'Prefix for every resource name.', '', '');
    add('environment', 'review', 'Environment label (dev, staging, prod).', '', '');
    if (!c.answerOnly) {
      add('agent_image', 'review', 'Container image for the agent service. Starts as a placeholder hello image; replace with your build of the agent/ directory.', 'gcloud builds submit agent/ --tag ...', 'the agent actually serving');
      add('generation_instruction', 'review', 'System instruction for the drafting step. Generic on purpose; set it to your task wording.', '', '');
      add('validation_instruction', 'review', 'System instruction for the validation step.', '', '');
    }
    if (c.vpcsc) add('access_policy_id', 'gated', 'Access Context Manager access policy id (org or folder scoped). Empty deploys without the VPC-SC perimeter.', 'gcloud access-context-manager policies list', 'the VPC-SC perimeter');
    if (c.website) add('site_url', 'gated', 'Owned site URL to crawl into the search index. Empty skips the crawl target (the data store is still created). The URI pattern is computed in HCL, so this is a plain tfvar.', '', 'the website crawl target');
    if (c.selfHost) add('vllm_endpoint', 'gated', 'OpenAI-compatible endpoint of your vLLM service (for example http://IP:8000/v1). Empty leaves the agent pointing at the model id alone, which fails for a self-hosted-only design.', 'after deploying the vLLM stack on the inference cluster', 'the self-hosted model calls');
    if (c.hybrid) {
      add('onprem_interconnect', 'gated', 'Self-link of your existing Cloud Interconnect (Dedicated). Empty deploys without the on-prem link.', 'gcloud compute interconnects list --uri', 'the Cloud Router + VLAN attachment');
      add('onprem_cidrs', 'gated', 'On-premise IP ranges allowed to reach the system over the interconnect. Empty disables the ingress firewall rule.', 'your network team', 'the on-prem ingress firewall');
      add('cloud_router_asn', 'review', 'BGP ASN for the Cloud Router that peers with your on-prem edge.', 'your network team', '');
      add('onprem_dns_domain', 'gated', 'On-premise DNS domain to forward from the VPC (for example corp.example.com.). Needs onprem_dns_servers too.', 'your network team', 'the private DNS forwarding zone');
      add('onprem_dns_servers', 'gated', 'On-premise DNS server IPs the forwarding zone targets.', 'your network team', 'the private DNS forwarding zone');
    }
    return P;
  }

  /* ---------- manual steps: not expressible as tfvars ----------
     Static text dictionary so the steps list, README sections, and the inline
     HCL comments are rendered from one source and cannot drift.
     when: 'before-apply' | 'after-apply'; kind: 'step' | 'note'. */
  var STEP_TEXT = {
    'build-image': {
      title: 'Build and push the agent container',
      detail: 'The services start from a placeholder image. Build the agent/ directory, push it to Artifact Registry, and set agent_image in terraform.tfvars:\n\n```\ngcloud builds submit agent/ --tag REGION-docker.pkg.dev/PROJECT/REPO/agent:latest\n```',
      inline: 'Placeholder image; build agent/ and set var.agent_image (see README: Build and push the agent container).'
    },
    'adk-deploy': {
      title: 'Push the agent to Agent Runtime with the ADK CLI',
      detail: 'Agent Runtime packages the agent code at build time, which Terraform cannot do, so no reasoning-engine resource is emitted here. After apply, push the agent object with:\n\n```\nadk deploy agent_engine --agent agent/\n```',
      inline: ''
    },
    'note-dlp-deid': {
      title: 'De-identify the corpus before import (DLP)',
      detail: 'This design de-identifies documents BEFORE they are embedded or indexed, and neither Agent Search nor the ingestion pipeline redacts for you. Run a Sensitive Data Protection de-identification pass over the corpus bucket (for example the Dataflow "De-identify GCS data" template with an inspect + de-identify template pair) and point the import/backfill at the de-identified output, not the raw bucket.',
      inline: ''
    },
    'answer-api': {
      title: 'Wire clients to the Agent Search answer API',
      detail: 'This design has no agent of its own: clients (or your existing API edge) call the Agent Search engine answer endpoint directly, and the grounded answer is generated inside the service. Grant caller identities roles/discoveryengine.viewer (or front the API with IAP / your gateway) and point them at the engine created next to the data store (ids in the Terraform outputs).',
      inline: ''
    },
    'two-phase-apply': {
      title: 'GKE runtime: two-phase apply',
      detail: 'The kubernetes provider connects to the cluster this same config creates, so apply in two phases:\n\n```\nterraform apply -target=google_container_cluster.agent\nterraform apply\n```',
      inline: 'Two-phase apply: create this cluster first, then the kubernetes_* resources (see README).'
    },
    'site-verify': {
      title: 'Verify site ownership before the crawl',
      detail: 'The owned-site data store crawls site_url, but the crawler indexes nothing until you verify ownership of the domain in the console (Agent Search > Data stores > your site store > verify). Apply succeeds either way, so this failure is silent.',
      inline: 'Crawl target. The crawler indexes nothing until site ownership is verified in the console (see README).'
    },
    'import-docs': {
      title: 'Upload and import your documents',
      detail: 'Upload source documents to the seed-docs prefix, then import them into the search data store from the console or the API:\n\n```\ngsutil -m cp -r ./my-docs/* "$(terraform output -raw seed_docs_uri)"\n```',
      inline: 'Holds your source documents; import them into the search index after apply (see README).'
    },
    'scann-extension': {
      title: 'Enable the ScaNN extension in AlloyDB',
      detail: 'The ScaNN index is a database extension, not a Terraform resource. After apply, connect to the AlloyDB instance through its PSC endpoint and run:\n\n```\nCREATE EXTENSION IF NOT EXISTS alloydb_scann;\n```\n\nthen create your vector table and ScaNN index per the AlloyDB ScaNN docs.',
      inline: 'Vector store. The ScaNN extension is enabled with SQL after apply, not by Terraform (see README).'
    },
    'vector-backfill': {
      title: 'Backfill embeddings and deploy the Vector Search index',
      detail: 'The index is created empty against the gs:// vector-index/ prefix. Run your embedding backfill into that prefix, then deploy the index to the endpoint (console or API). Queries fail until the index is deployed.',
      inline: 'Created empty; backfill embeddings into the GCS prefix and deploy the index to the endpoint after apply (see README).'
    },
    'claude-terms': {
      title: 'Enable the Claude partner model',
      detail: 'Claude models on the Agent Platform require accepting the partner model terms in the model garden once per project before calls succeed. Apply does not check this; the first model call fails without it.',
      inline: ''
    },
    'bgp-peer': {
      title: 'Bring up the BGP session',
      detail: 'After the VLAN attachment is up, add a google_compute_router_peer using the IPs the attachment allocates (cloud_router_ip_address / customer_router_ip_address) and your on-prem ASN.',
      inline: 'The BGP peer is added after apply, once the attachment allocates the session IPs (see README).'
    },
    'hybrid-ingress': {
      title: 'Wire private ingress and egress for the Cloud Run agent',
      detail: 'This design runs the agent on Cloud Run with internal-only ingress inside a private-only (hybrid) topology. For on-prem callers to reach it, front it with an internal Application Load Balancer (or a PSC endpoint) in the VPC; for the agent to reach on-prem systems, add a Serverless VPC Access connector and a vpc_access block on the service. Switching Agent compute to GKE puts the agent in the VPC and avoids this wiring.',
      inline: 'Internal-only ingress: reachable from the VPC / interconnect only after the internal ALB or PSC endpoint is wired (see README).'
    },
    'vllm-deploy': {
      title: 'Deploy the vLLM serving stack',
      detail: 'The inference cluster and GPU node pool are provisioned, but the vLLM serving layer (Deployment + Service, model weights, autoscaling) is application deployment, not infrastructure, so it is not emitted. Deploy vLLM onto the inference cluster, then set vllm_endpoint in terraform.tfvars to its OpenAI-compatible endpoint and re-apply so the agent picks it up. Size the fleet with the serving-performance calculator.',
      inline: 'GPU capacity only; the vLLM Deployment/Service is deployed after apply, then wired via var.vllm_endpoint (see README).'
    },
    'redis-auth': {
      title: 'Store the Redis AUTH credential',
      detail: 'The Secret Manager secret is created empty (Terraform must not hold credential values in state). Add the Redis AUTH string as a secret version after apply:\n\n```\nprintf \'REDACTED\' | gcloud secrets versions add NAME --data-file=-\n```',
      inline: 'Created empty on purpose; add the Redis AUTH value as a secret version after apply (see README).'
    },
    'iap-brand': {
      title: 'IAP needs an OAuth consent brand',
      detail: 'The design fronts users with IAP, but an IAP brand (OAuth consent screen with an org-internal support email) is org-dependent and is not emitted here. Configure IAP on the load balancer / gateway from the console.',
      inline: ''
    },
    'note-model-map': {
      title: 'Model id mapping',
      detail: 'Catalog model ids were mapped to deployable Vertex model ids by the generator (see the MODEL_MAP constant and the generation_model / validation_model tfvars). Model launches move faster than this tool; verify both ids exist in your region before relying on them.',
      inline: ''
    },
    'note-apigee': {
      title: 'API Gateway, not Apigee',
      detail: 'The edge is emitted as Cloud API Gateway (light, free tier). Apigee is the upgrade path when you need quota plans, monetization, or advanced policies; provisioning an Apigee org is heavyweight and billing-bearing, so it is deliberately not emitted.',
      inline: ''
    },
    'note-dataflow': {
      title: 'Ingestion pipeline not emitted',
      detail: 'The self-built design runs a Dataflow ingestion pipeline (parse, chunk, embed) in the BoM, but a useful pipeline is application code, not infrastructure; wire your own job against the Document AI processor and the vector store.',
      inline: ''
    },
    'note-worm': {
      title: 'WORM log bucket is not locked',
      detail: 'The audit log bucket carries the 36-month retention but locked = false, so a test apply can be destroyed. Set locked = true for production compliance; locking is irreversible.',
      inline: 'retention is WORM-grade only when locked = true; left false so a test apply can be destroyed (see README).'
    },
    'note-spanner-config': {
      title: 'Spanner multi-region config',
      detail: 'Multi-region active-active is on, but the Spanner instance is emitted with a regional config as a safe default. Change config to a multi-region one (for example nam11 or eur6) to actually serve active-active writes.',
      inline: 'Regional config by default; switch to a multi-region config (nam11 / eur6) for active-active (see README).'
    }
  };

  function stepsFor(c) {
    var S = [];
    var add = function (id, when, kind) { S.push({ id: id, when: when, kind: kind || 'step', title: STEP_TEXT[id].title, detail: STEP_TEXT[id].detail }); };
    /* before-apply steps */
    if (c.gke) add('two-phase-apply', 'before-apply');
    if (c.claude) add('claude-terms', 'before-apply');
    if (c.vais && c.website) add('site-verify', 'before-apply');
    /* after-apply steps */
    if (!c.answerOnly) add('build-image', 'after-apply');
    if (c.answerOnly) add('answer-api', 'after-apply');
    if (c.runtime === 'agentengine') add('adk-deploy', 'after-apply');
    if (c.vais && c.docCorpus) add('import-docs', 'after-apply');
    if (c.vectorAlloy) add('scann-extension', 'after-apply');
    if (c.vectorVertex) add('vector-backfill', 'after-apply');
    if (c.selfHost) add('vllm-deploy', 'after-apply');
    if (c.hybrid) add('bgp-peer', 'after-apply');
    if (c.hybrid && c.runtime === 'agentengine') add('hybrid-ingress', 'after-apply');
    if (c.secretManagerOn) add('redis-auth', 'after-apply');
    if (c.gateway) add('iap-brand', 'after-apply');
    /* notes */
    add('note-model-map', 'after-apply', 'note');
    if (c.dlpDeid) add('note-dlp-deid', 'after-apply', 'note');
    if (c.publicGateway) add('note-apigee', 'after-apply', 'note');
    if (c.selfbuilt && (c.ingestionSep || c.website)) add('note-dataflow', 'after-apply', 'note');
    if (c.auditLog) add('note-worm', 'after-apply', 'note');
    if (c.multiRegion && c.stateSpanner) add('note-spanner-config', 'after-apply', 'note');
    return S;
  }
  /* Inline HCL comment for a step id; '' when the step has no resource anchor. */
  function inline(id) { return STEP_TEXT[id].inline ? '# ' + STEP_TEXT[id].inline : ''; }

  /* ---------- file emitters ---------- */
  function apiList(c) {
    var apis = ['aiplatform.googleapis.com', 'storage.googleapis.com', 'logging.googleapis.com', 'cloudtrace.googleapis.com', 'bigquery.googleapis.com', 'iam.googleapis.com'];
    if (c.vais) apis.push('discoveryengine.googleapis.com');
    if (c.runtime === 'agentengine' || c.hitl) apis.push('run.googleapis.com');
    if (c.publicGateway) { apis.push('apigateway.googleapis.com'); apis.push('servicemanagement.googleapis.com'); apis.push('servicecontrol.googleapis.com'); }
    if (c.armor) apis.push('modelarmor.googleapis.com');
    if (c.alloyAny) apis.push('alloydb.googleapis.com');
    if (c.stateSpanner) apis.push('spanner.googleapis.com');
    if (c.stateCloudSql) apis.push('sqladmin.googleapis.com');
    if (c.redisManaged) { apis.push('redis.googleapis.com'); apis.push('networkconnectivity.googleapis.com'); }
    if (c.automation) apis.push('pubsub.googleapis.com');
    if (c.cmek) apis.push('cloudkms.googleapis.com');
    if (c.vpcsc) apis.push('accesscontextmanager.googleapis.com');
    if (c.secretManagerOn) apis.push('secretmanager.googleapis.com');
    if (c.docai) apis.push('documentai.googleapis.com');
    if (c.gke || c.selfHost) apis.push('container.googleapis.com');
    if (c.networkUser || c.vpc) apis.push('compute.googleapis.com');
    if (c.hybrid) apis.push('dns.googleapis.com');
    return apis;
  }

  function versionsTf(c) {
    var providers = [
      '    google = {',
      '      source  = "hashicorp/google"',
      '      version = ">= 6.0.0"',
      '    }',
      '    google-beta = {',
      '      source  = "hashicorp/google-beta"',
      '      version = ">= 6.0.0"',
      '    }'
    ];
    if (c.gke || c.selfHost) {
      providers.push('    kubernetes = {');
      providers.push('      source  = "hashicorp/kubernetes"');
      providers.push('      version = ">= 2.27.0"');
      providers.push('    }');
    }
    var out = [
      'terraform {',
      '  required_version = ">= 1.6.0"',
      '  required_providers {',
      providers.join('\n'),
      '  }',
      '}',
      '',
      'provider "google" {',
      '  project = var.project_id',
      '  region  = var.region',
      '}',
      '',
      'provider "google-beta" {',
      '  project = var.project_id',
      '  region  = var.region',
      '}'
    ];
    if (c.gke) {
      out.push('');
      out.push('data "google_client_config" "default" {}');
      out.push('');
      out.push(inline('two-phase-apply'));
      out.push('provider "kubernetes" {');
      out.push('  host                   = "https://${google_container_cluster.agent.endpoint}"');
      out.push('  token                  = data.google_client_config.default.access_token');
      out.push('  cluster_ca_certificate = base64decode(google_container_cluster.agent.master_auth[0].cluster_ca_certificate)');
      out.push('}');
    }
    return out.join('\n') + '\n';
  }

  function variablesTf(c) {
    var blocks = [];
    function v(name, type, def, desc, validation) {
      var b = ['variable "' + name + '" {'];
      b.push('  description = ' + q(desc));
      b.push('  type        = ' + type);
      if (def !== undefined) b.push('  default     = ' + def);
      if (validation) {
        b.push('  validation {');
        b.push('    condition     = ' + validation[0]);
        b.push('    error_message = ' + q(validation[1]));
        b.push('  }');
      }
      b.push('}');
      blocks.push(b.join('\n'));
    }
    v('project_id', 'string', undefined, 'Target Google Cloud project id. No default: set it in terraform.tfvars.',
      ['length(var.project_id) > 0 && var.project_id != "REPLACE_ME"', 'Set project_id in terraform.tfvars to your target GCP project id.']);
    /* Residency-pinned designs get no region default: the choice is a compliance
       decision, so terraform plan must stop until it is made deliberately. */
    v('region', 'string', c.residencyPin ? undefined : q('us-central1'), c.residencyPin ? 'Primary region. This design pins data residency, so pick the region your compliance posture requires. No default on purpose.' : 'Primary region for regional resources.');
    v('name_prefix', 'string', q('agentic-design'), 'Prefix for resource names.');
    v('environment', 'string', q('dev'), 'Environment label, for example dev or prod.');
    if (!c.answerOnly) {
      v('agent_image', 'string', q('us-docker.pkg.dev/cloudrun/container/hello'), 'Container image for the agent service. Replace with your build of the agent/ directory.');
      v('generation_instruction', 'string', q('Generate a clear, accurate, grounded answer to the request.'), 'System instruction for the drafting step. Generic; set per deployment.');
      v('validation_instruction', 'string', q('Check the answer is accurate, on topic, and free of personal data. Reply APPROVE or REVISE with a reason.'), 'System instruction for the validation step.');
      v('generation_model', 'string', q(c.reasoningModel), 'Vertex model id for the reasoning / drafting steps.');
      v('validation_model', 'string', q(c.fastModel), 'Vertex model id for the fast / validation steps.');
    }
    v('labels', 'map(string)', '{\n    managed-by = "system-design"\n  }', 'Labels applied to resources that support them.');
    if (c.vpcsc) v('access_policy_id', 'string', q(''), 'Access Context Manager access policy id (org or folder scoped). Empty deploys without the VPC-SC perimeter.');
    if (c.website) v('site_url', 'string', q(''), 'Owned site URL to crawl into the search index. Empty skips the crawl target.');
    if (c.hybrid) {
      v('onprem_interconnect', 'string', q(''), 'Self-link of your existing Cloud Interconnect (Dedicated). Empty deploys without the on-prem link.');
      v('onprem_cidrs', 'list(string)', '[]', 'On-premise IP ranges allowed to reach the system over the interconnect. Empty disables the ingress firewall rule.');
      v('cloud_router_asn', 'number', '64514', 'BGP ASN for the Cloud Router that peers with your on-prem edge.');
      v('onprem_dns_domain', 'string', q(''), 'On-premise DNS domain to forward from the VPC (for example corp.example.com.). Needs onprem_dns_servers too.');
      v('onprem_dns_servers', 'list(string)', '[]', 'On-premise DNS server IPs the forwarding zone targets.');
    }
    if (c.alloyAny) v('alloydb_cpu_count', 'number', String(c.alloyCpu), 'AlloyDB primary vCPUs. Default derived from the design peak of ~' + c.peakQps + ' QPS.');
    if (c.stateSpanner) v('spanner_processing_units', 'number', String(c.spannerPU), 'Spanner processing units. Default derived from the design peak of ~' + c.peakQps + ' QPS at ~100 QPS per 1000 PU.');
    if (c.redisManaged) v('redis_shard_count', 'number', String(c.redisShards), 'Memorystore Redis Cluster shard count.');
    if (c.selfHost) {
      v('gpu_node_count', 'number', String(c.gpuNodes), 'GPU nodes in the self-hosted inference pool. Size the fleet with the serving calculator.');
      v('vllm_endpoint', 'string', q(''), 'OpenAI-compatible endpoint of your vLLM service, set after deploying it on the inference cluster. Empty until then.');
    }
    return blocks.join('\n\n') + '\n';
  }

  function tfvarsFile(c, placeholders) {
    var L = ['# Deployment values. Generated by the System Design tool; the architecture is'];
    L.push('# main.tf, these are the deploy specifics. Lines commented out are placeholders');
    L.push('# you must fill in (terraform plan stops on the required ones).');
    L.push('');
    L.push('# --- required ---');
    L.push('# project_id = "REPLACE_ME"   # ' + 'gcloud projects list');
    if (c.residencyPin) L.push('# region     = "..."          # residency is pinned in this design: pick the compliant region deliberately');
    L.push('');
    L.push('# --- review before real use (safe defaults) ---');
    if (!c.residencyPin) L.push('region                 = "us-central1"');
    L.push('name_prefix            = "agentic-design"');
    L.push('environment            = "dev"');
    if (!c.answerOnly) {
      L.push('# agent_image          = "REGION-docker.pkg.dev/PROJECT/REPO/agent:latest"   # after: gcloud builds submit agent/');
      L.push('# generation_instruction = "..."   # your task wording');
      L.push('# validation_instruction = "..."');
    }
    var gated = placeholders.filter(function (p) { return p.kind === 'gated'; });
    if (gated.length) {
      L.push('');
      L.push('# --- optional feature gates (empty = that feature is skipped, plan stays clean) ---');
      gated.forEach(function (p) {
        L.push('# ' + p.var + ' = ' + (p.var.indexOf('cidrs') >= 0 || p.var.indexOf('servers') >= 0 ? '[...]' : '"..."') + '   # gates ' + p.gatesWhat + (p.whereToGet ? '; from: ' + p.whereToGet : ''));
      });
    }
    return L.join('\n') + '\n';
  }

  /* env pairs the agent container reads, shared by Cloud Run and GKE */
  function agentEnvPairs(c) {
    var pairs = [
      ['GOOGLE_CLOUD_PROJECT', 'var.project_id'],
      ['GOOGLE_CLOUD_REGION', 'var.region'],
      ['GENERATION_INSTRUCTION', 'var.generation_instruction'],
      ['VALIDATION_INSTRUCTION', 'var.validation_instruction'],
      ['GENERATION_MODEL', 'var.generation_model'],
      ['VALIDATION_MODEL', 'var.validation_model'],
      ['AGENT_PATTERN', q(c.pattern)],
      ['NUM_AGENTS', q(String(c.numAgents))],
      ['REACT_MAX_ITER', q(String(c.reactMaxIter))]
    ];
    if (c.vais) pairs.push(['GROUNDING_DATASTORE_ID', c.docCorpus ? 'google_discovery_engine_data_store.docs.data_store_id' : 'google_discovery_engine_data_store.site.data_store_id']);
    if (c.vectorVertex) pairs.push(['VECTOR_INDEX_ENDPOINT', 'google_vertex_ai_index_endpoint.vectors.name']);
    if (c.vectorAlloy) pairs.push(['ALLOYDB_VECTOR_HOST', 'google_compute_address.' + (c.stateAlloy ? 'alloydb_psc' : 'alloydb_vec_psc') + '.address']);
    if (c.stateAlloy) pairs.push(['STATE_DB_HOST', 'google_compute_address.alloydb_psc.address']);
    if (c.stateCloudSql) pairs.push(['STATE_DB_HOST', 'google_compute_address.cloudsql_psc.address']);
    if (c.stateSpanner) pairs.push(['SPANNER_INSTANCE', 'google_spanner_instance.state.name']);
    if (c.redisManaged) pairs.push(['REDIS_HOST', 'google_redis_cluster.cache.discovery_endpoints[0].address']);
    if (c.redisOnGke) pairs.push(['REDIS_URL', q('redis://redis:6379')]);
    if (c.selfHost) pairs.push(['VLLM_ENDPOINT', 'var.vllm_endpoint']);
    return pairs;
  }
  function cloudRunEnv(pairs) {
    return pairs.map(function (p) {
      return ['      env {', '        name  = ' + q(p[0]), '        value = ' + p[1], '      }'].join('\n');
    }).join('\n');
  }
  function k8sEnv(pairs) {
    return pairs.map(function (p) {
      return ['          env {', '            name  = ' + q(p[0]), '            value = ' + p[1], '          }'].join('\n');
    }).join('\n');
  }

  function mainTf(c) {
    var B = [];
    var DEP = '  depends_on = [google_project_service.enabled]';

    var locals = ['locals {', '  name = "${var.name_prefix}-${var.environment}"'];
    if (c.website) {
      locals.push('  # Crawl pattern computed in HCL so site_url stays a plain tfvar.');
      locals.push('  site_host        = var.site_url == "" ? "" : regex("^(?:https?://)?([^/]+)", var.site_url)[0]');
      locals.push('  site_uri_pattern = local.site_host == "" ? "" : "${local.site_host}/*"');
    }
    locals.push('}');
    B.push(locals.join('\n'));

    if (c.automation || c.vpcsc) B.push('data "google_project" "this" {}');

    B.push([
      'resource "google_project_service" "enabled" {',
      '  for_each = toset([',
      apiList(c).map(function (a) { return '    ' + q(a) + ','; }).join('\n'),
      '  ])',
      '  service            = each.value',
      '  disable_on_destroy = false',
      '}'
    ].join('\n'));

    /* The dedicated VPC wraps self-hosted compute only (and the hybrid Cloud
       Router); managed stores sit outside it, reached over PSC endpoints. */
    if (c.vpc) {
      B.push([
        '# Dedicated VPC for the self-hosted compute' + (c.hybrid ? ' and the hybrid Cloud Router' : '') + '. Managed stores',
        '# are reached from it over Private Service Connect endpoints; they do not live in it.',
        'resource "google_compute_network" "vpc" {',
        '  name                    = "${local.name}-vpc"',
        '  auto_create_subnetworks = true',
        DEP,
        '}'
      ].join('\n'));
    }
    if (c.pscStores) {
      B.push([
        '# Shared PSC consumer subnet: the managed-store endpoints draw their IPs here.',
        'data "google_compute_subnetwork" "psc" {',
        '  name       = ' + (c.vpc ? 'google_compute_network.vpc.name' : '"default"'),
        '  region     = var.region',
        '  project    = var.project_id',
        '  depends_on = [' + (c.vpc ? 'google_compute_network.vpc' : 'google_project_service.enabled') + ']',
        '}'
      ].join('\n'));
    }

    /* service account + IAM: one runtime identity, least-privilege-ish roles.
       The no-agent design has no runtime identity: callers reach the Agent
       Search answer API with their own identities (see the answer-api step). */
    if (!c.answerOnly) {
      B.push([
        'resource "google_service_account" "agent" {',
        '  account_id   = "${local.name}-agent"',
        '  display_name = "Agent runtime service account"',
        DEP,
        '}'
      ].join('\n'));
      var roles = ['roles/aiplatform.user', 'roles/storage.objectAdmin', 'roles/logging.logWriter', 'roles/cloudtrace.agent', 'roles/bigquery.dataEditor'];
      if (c.vais) roles.push('roles/discoveryengine.editor');
      if (c.secretManagerOn) roles.push('roles/secretmanager.secretAccessor');
      if (c.alloyAny) roles.push('roles/alloydb.client');
      if (c.stateSpanner) roles.push('roles/spanner.databaseUser');
      if (c.stateCloudSql) roles.push('roles/cloudsql.client');
      roles.forEach(function (role, i) {
        B.push([
          'resource "google_project_iam_member" "agent_' + i + '" {',
          '  project = var.project_id',
          '  role    = ' + q(role),
          '  member  = "serviceAccount:${google_service_account.agent.email}"',
          '}'
        ].join('\n'));
      });
    }

    /* CMEK: key ring + key + a service-agent binding per managed store family.
       Self-hosted stores (Redis on GKE) take disk/app encryption, not a key. */
    if (c.cmek) {
      B.push([
        'resource "google_kms_key_ring" "ring" {',
        '  name     = "${local.name}-ring"',
        '  location = var.region',
        DEP,
        '}',
        '',
        'resource "google_kms_crypto_key" "key" {',
        '  name            = "${local.name}-key"',
        '  key_ring        = google_kms_key_ring.ring.id',
        '  rotation_period = "7776000s"',
        '}',
        '',
        'data "google_storage_project_service_account" "gcs" {}',
        '',
        'resource "google_kms_crypto_key_iam_member" "gcs" {',
        '  crypto_key_id = google_kms_crypto_key.key.id',
        '  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"',
        '  member        = "serviceAccount:${data.google_storage_project_service_account.gcs.email_address}"',
        '}'
      ].join('\n'));
      var kmsAgent = function (name, service, member) {
        var idRes = service
          ? 'resource "google_project_service_identity" "' + name + '" {\n  provider = google-beta\n  service  = ' + q(service) + '\n' + DEP + '\n}\n\n'
          : '';
        return idRes +
          'resource "google_kms_crypto_key_iam_member" "' + name + '" {\n' +
          '  crypto_key_id = google_kms_crypto_key.key.id\n' +
          '  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"\n' +
          '  member        = "serviceAccount:' + member + '"\n}';
      };
      if (c.alloyAny) B.push(kmsAgent('alloydb', 'alloydb.googleapis.com', '${google_project_service_identity.alloydb.email}'));
      if (c.stateSpanner) B.push(kmsAgent('spanner', 'spanner.googleapis.com', '${google_project_service_identity.spanner.email}'));
      if (c.stateCloudSql) B.push(kmsAgent('cloudsql', 'sqladmin.googleapis.com', '${google_project_service_identity.cloudsql.email}'));
      if (c.redisManaged) B.push(kmsAgent('redis', 'redis.googleapis.com', '${google_project_service_identity.redis.email}'));
      B.push('data "google_bigquery_default_service_account" "bq" {}\n\n' + kmsAgent('bigquery', null, '${data.google_bigquery_default_service_account.bq.email}'));
    }

    /* data bucket: source docs, agent artifacts, vector index staging */
    var enc = c.cmek ? ['  encryption {', '    default_kms_key_name = google_kms_crypto_key.key.id', '  }'].join('\n') : '';
    var bucketDep = c.cmek ? '  depends_on = [google_project_service.enabled, google_kms_crypto_key_iam_member.gcs]' : DEP;
    B.push([
      'resource "google_storage_bucket" "data" {',
      '  name                        = "${var.project_id}-${local.name}-data"',
      '  location                    = var.region',
      '  uniform_bucket_level_access = true',
      '  force_destroy               = true',
      '  labels                      = var.labels',
      enc,
      bucketDep,
      '}'
    ].filter(Boolean).join('\n'));
    if (c.docCorpus || c.website) {
      B.push([
        inline('import-docs'),
        'resource "google_storage_bucket_object" "seed_docs_keep" {',
        '  name    = "seed-docs/.keep"',
        '  bucket  = google_storage_bucket.data.name',
        '  content = "Upload your source documents under the seed-docs/ prefix."',
        '}'
      ].filter(Boolean).join('\n'));
    }

    /* managed retrieval: Agent Search data stores + engines */
    if (c.vais && c.docCorpus) {
      B.push([
        'resource "google_discovery_engine_data_store" "docs" {',
        '  location          = "global"',
        '  data_store_id     = "${local.name}-docs"',
        '  display_name      = "Document corpus"',
        '  industry_vertical = "GENERIC"',
        '  content_config    = "CONTENT_REQUIRED"',
        '  solution_types    = ["SOLUTION_TYPE_SEARCH"]',
        DEP,
        '}',
        '',
        'resource "google_discovery_engine_search_engine" "docs" {',
        '  engine_id         = "${local.name}-docs-engine"',
        '  collection_id     = "default_collection"',
        '  location          = "global"',
        '  display_name      = "Docs search"',
        '  industry_vertical = "GENERIC"',
        '  data_store_ids    = [google_discovery_engine_data_store.docs.data_store_id]',
        '  search_engine_config {',
        '    search_tier = "SEARCH_TIER_ENTERPRISE"',
        '  }',
        '}'
      ].join('\n'));
    }
    if (c.vais && c.website) {
      B.push([
        'resource "google_discovery_engine_data_store" "site" {',
        '  location                    = "global"',
        '  data_store_id               = "${local.name}-site"',
        '  display_name                = "Owned site"',
        '  industry_vertical           = "GENERIC"',
        '  content_config              = "PUBLIC_WEBSITE"',
        '  solution_types              = ["SOLUTION_TYPE_SEARCH"]',
        '  create_advanced_site_search = true',
        DEP,
        '}',
        '',
        inline('site-verify'),
        'resource "google_discovery_engine_target_site" "owned" {',
        '  count                = var.site_url == "" ? 0 : 1',
        '  location             = google_discovery_engine_data_store.site.location',
        '  data_store_id        = google_discovery_engine_data_store.site.data_store_id',
        '  provided_uri_pattern = local.site_uri_pattern',
        '  type                 = "INCLUDE"',
        '  exact_match          = false',
        '}',
        '',
        'resource "google_discovery_engine_search_engine" "site" {',
        '  engine_id         = "${local.name}-site-engine"',
        '  collection_id     = "default_collection"',
        '  location          = "global"',
        '  display_name      = "Site search"',
        '  industry_vertical = "GENERIC"',
        '  data_store_ids    = [google_discovery_engine_data_store.site.data_store_id]',
        '  search_engine_config {',
        '    search_tier = "SEARCH_TIER_ENTERPRISE"',
        '  }',
        '}'
      ].join('\n'));
    }

    /* self-built retrieval: managed ScaNN store + Document AI parser */
    if (c.vectorVertex) {
      B.push([
        'resource "google_storage_bucket_object" "vector_index_keep" {',
        '  name    = "vector-index/.keep"',
        '  bucket  = google_storage_bucket.data.name',
        '  content = "Embedding backfill target for the Vector Search index."',
        '}',
        '',
        inline('vector-backfill'),
        'resource "google_vertex_ai_index" "vectors" {',
        '  region       = var.region',
        '  display_name = "${local.name}-vectors"',
        '  metadata {',
        '    contents_delta_uri = "gs://${google_storage_bucket.data.name}/vector-index/"',
        '    config {',
        '      dimensions                  = 768',
        '      approximate_neighbors_count = 150',
        '      shard_size                  = "SHARD_SIZE_SMALL"',
        '      distance_measure_type       = "DOT_PRODUCT_DISTANCE"',
        '      algorithm_config {',
        '        tree_ah_config {}',
        '      }',
        '    }',
        '  }',
        '  index_update_method = "BATCH_UPDATE"',
        DEP,
        '}',
        '',
        'resource "google_vertex_ai_index_endpoint" "vectors" {',
        '  region                  = var.region',
        '  display_name            = "${local.name}-vectors-ep"',
        '  public_endpoint_enabled = true',
        DEP,
        '}'
      ].join('\n'));
    }
    if (c.vectorAlloy && !c.stateAlloy) {
      B.push(alloyCluster(c, 'vectors', inline('scann-extension')));
    }
    if (c.docai) {
      B.push([
        '# Parses source documents to clean structured text before chunking and embedding.',
        'resource "google_document_ai_processor" "ocr" {',
        '  location     = "us"',
        '  display_name = "${local.name}-ocr"',
        '  type         = "OCR_PROCESSOR"',
        DEP,
        '}'
      ].join('\n'));
    }

    /* Model Armor */
    if (c.armor) {
      B.push([
        'resource "google_model_armor_template" "guard" {',
        '  provider    = google-beta',
        '  location    = var.region',
        '  template_id = "${local.name}-armor"',
        '  filter_config {',
        '    pi_and_jailbreak_filter_settings {',
        '      filter_enforcement = "ENABLED"',
        '      confidence_level   = "MEDIUM_AND_ABOVE"',
        '    }',
        '    malicious_uri_filter_settings {',
        '      filter_enforcement = "ENABLED"',
        '    }',
        '  }',
        DEP,
        '}'
      ].join('\n'));
    }

    var pairs = agentEnvPairs(c);

    /* agent compute */
    if (c.runtime === 'agentengine') {
      var ingress = c.privateOnly ? 'INGRESS_TRAFFIC_INTERNAL_ONLY' : 'INGRESS_TRAFFIC_ALL';
      B.push([
        '# The agent API service. Agent Runtime objects are pushed with the ADK CLI after',
        '# apply (adk deploy agent_engine --agent agent/); Terraform provisions the',
        '# supporting infrastructure only.',
        c.privateOnly ? inline('hybrid-ingress') : inline('build-image'),
        'resource "google_cloud_run_v2_service" "api" {',
        '  name                = "${local.name}-api"',
        '  location            = var.region',
        '  ingress             = ' + q(ingress),
        '  deletion_protection = false',
        '  template {',
        '    service_account = google_service_account.agent.email',
        '    containers {',
        '      image = var.agent_image',
        cloudRunEnv(pairs),
        '    }',
        '  }',
        DEP,
        '}'
      ].filter(Boolean).join('\n'));
      if (c.publicGateway) {
        B.push([
          'resource "google_service_account" "gateway" {',
          '  account_id   = "${local.name}-gw"',
          '  display_name = "API Gateway backend invoker"',
          DEP,
          '}',
          '',
          'resource "google_cloud_run_v2_service_iam_member" "gw_invoker" {',
          '  name     = google_cloud_run_v2_service.api.name',
          '  location = google_cloud_run_v2_service.api.location',
          '  role     = "roles/run.invoker"',
          '  member   = "serviceAccount:${google_service_account.gateway.email}"',
          '}',
          '',
          'resource "google_api_gateway_api" "api" {',
          '  provider = google-beta',
          '  api_id   = "${local.name}-gw"',
          DEP,
          '}',
          '',
          'resource "google_api_gateway_api_config" "api" {',
          '  provider      = google-beta',
          '  api           = google_api_gateway_api.api.api_id',
          '  api_config_id = "${local.name}-cfg"',
          '  openapi_documents {',
          '    document {',
          '      path     = "openapi.yaml"',
          '      contents = base64encode(local.openapi)',
          '    }',
          '  }',
          '  gateway_config {',
          '    backend_config {',
          '      google_service_account = google_service_account.gateway.email',
          '    }',
          '  }',
          '  lifecycle {',
          '    create_before_destroy = true',
          '  }',
          '}',
          '',
          'resource "google_api_gateway_gateway" "gw" {',
          '  provider   = google-beta',
          '  region     = var.region',
          '  gateway_id = "${local.name}-gw"',
          '  api_config = google_api_gateway_api_config.api.id',
          '}',
          '',
          'locals {',
          '  openapi = <<-EOT',
          '    swagger: "2.0"',
          '    info:',
          '      title: ${local.name}-api',
          '      version: "1.0.0"',
          '    schemes:',
          '      - https',
          '    produces:',
          '      - application/json',
          '    paths:',
          '      /run:',
          '        post:',
          '          summary: Run the agent on a request',
          '          operationId: run',
          '          x-google-backend:',
          '            address: ${google_cloud_run_v2_service.api.uri}',
          '          responses:',
          '            "200":',
          '              description: ok',
          '  EOT',
          '}'
        ].join('\n'));
      }
    } else if (c.gke) {
      B.push([
        inline('two-phase-apply'),
        'resource "google_container_cluster" "agent" {',
        '  name                = "${local.name}-agent"',
        '  location            = var.region',
        '  enable_autopilot    = true',
        '  deletion_protection = false',
        '  network             = ' + netName(c),
        '  ip_allocation_policy {}',
        DEP,
        '}'
      ].join('\n'));
      if (c.redisOnGke) {
        B.push([
          '# Self-hosted Redis in the cluster: the hot state tier and/or response cache,',
          '# reached at redis://redis:6379. Disk and app encryption, not CMEK.',
          'resource "kubernetes_deployment_v1" "redis" {',
          '  metadata {',
          '    name   = "redis"',
          '    labels = { app = "redis" }',
          '  }',
          '  spec {',
          '    replicas = 1',
          '    selector {',
          '      match_labels = { app = "redis" }',
          '    }',
          '    template {',
          '      metadata {',
          '        labels = { app = "redis" }',
          '      }',
          '      spec {',
          '        container {',
          '          name  = "redis"',
          '          image = "redis:7-alpine"',
          '          port {',
          '            container_port = 6379',
          '          }',
          '        }',
          '      }',
          '    }',
          '  }',
          '}',
          '',
          'resource "kubernetes_service_v1" "redis" {',
          '  metadata {',
          '    name = "redis"',
          '  }',
          '  spec {',
          '    selector = { app = "redis" }',
          '    port {',
          '      port        = 6379',
          '      target_port = 6379',
          '    }',
          '    type = "ClusterIP"',
          '  }',
          '}'
        ].join('\n'));
      }
      var lbMeta = ['  metadata {', '    name = "agent"'];
      if (c.privateOnly) {
        lbMeta.push('    # Private-only ingress: internal LoadBalancer, reachable over the interconnect.');
        lbMeta.push('    annotations = {');
        lbMeta.push('      "networking.gke.io/load-balancer-type" = "Internal"');
        lbMeta.push('    }');
      }
      lbMeta.push('  }');
      B.push([
        inline('build-image'),
        'resource "kubernetes_deployment_v1" "agent" {',
        '  metadata {',
        '    name   = "agent"',
        '    labels = { app = "agent" }',
        '  }',
        '  spec {',
        '    replicas = 2',
        '    selector {',
        '      match_labels = { app = "agent" }',
        '    }',
        '    template {',
        '      metadata {',
        '        labels = { app = "agent" }',
        '      }',
        '      spec {',
        '        container {',
        '          name  = "agent"',
        '          image = var.agent_image',
        k8sEnv(pairs),
        '          port {',
        '            container_port = 8080',
        '          }',
        '        }',
        '      }',
        '    }',
        '  }',
        '}',
        '',
        'resource "kubernetes_service_v1" "agent" {',
        lbMeta.join('\n'),
        '  spec {',
        '    selector = { app = "agent" }',
        '    port {',
        '      port        = 80',
        '      target_port = 8080',
        '    }',
        '    type = "LoadBalancer"',
        '  }',
        '}'
      ].join('\n'));
    }

    /* human review surface for automation HITL */
    if (c.automation && c.hitl) {
      B.push([
        '# Human-review surface for the approval gate. Replace the image with your review app.',
        'resource "google_cloud_run_v2_service" "review" {',
        '  name                = "${local.name}-review"',
        '  location            = var.region',
        (c.privateOnly ? '  ingress             = "INGRESS_TRAFFIC_INTERNAL_ONLY"' : ''),
        '  deletion_protection = false',
        '  template {',
        '    service_account = google_service_account.agent.email',
        '    containers {',
        '      image = var.agent_image',
        '    }',
        '  }',
        DEP,
        '}'
      ].filter(Boolean).join('\n'));
    }

    /* state stores */
    if (c.stateAlloy) B.push(alloyCluster(c, 'state', c.vectorAlloy ? inline('scann-extension') : ''));
    if (c.stateSpanner) {
      var spanEnc = c.cmek ? ['  encryption_config {', '    kms_key_name = google_kms_crypto_key.key.id', '  }', '  depends_on = [google_kms_crypto_key_iam_member.spanner]'] : [];
      B.push([
        (c.multiRegion ? inline('note-spanner-config') : ''),
        'resource "google_spanner_instance" "state" {',
        '  name             = "${local.name}-state"',
        '  config           = "regional-${var.region}"',
        '  display_name     = "Agent state"',
        '  processing_units = var.spanner_processing_units',
        DEP,
        '}',
        '',
        'resource "google_spanner_database" "state" {',
        '  instance = google_spanner_instance.state.name',
        '  name     = "agent"'
      ].concat(spanEnc).concat(['}']).filter(Boolean).join('\n'));
    }
    if (c.stateCloudSql) {
      var sqlEnc = c.cmek ? ['  encryption_key_name = google_kms_crypto_key.key.id'] : [];
      var sqlDep = c.cmek ? '  depends_on = [google_project_service.enabled, google_kms_crypto_key_iam_member.cloudsql]' : DEP;
      B.push([
        '# Cloud SQL reached over PSC: public IP off, consumer endpoint below.',
        'resource "google_sql_database_instance" "state" {',
        '  name                = "${local.name}-state"',
        '  region              = var.region',
        '  database_version    = "POSTGRES_16"',
        '  deletion_protection = false'
      ].concat(sqlEnc).concat([
        '  settings {',
        '    tier = "db-custom-2-7680"',
        '    ip_configuration {',
        '      ipv4_enabled = false',
        '      psc_config {',
        '        psc_enabled               = true',
        '        allowed_consumer_projects = [var.project_id]',
        '      }',
        '    }',
        '    backup_configuration {',
        '      enabled = true',
        '    }',
        '  }',
        sqlDep,
        '}',
        '',
        'resource "google_compute_address" "cloudsql_psc" {',
        '  name         = "${local.name}-cloudsql-psc"',
        '  region       = var.region',
        '  subnetwork   = data.google_compute_subnetwork.psc.id',
        '  address_type = "INTERNAL"',
        '}',
        '',
        'resource "google_compute_forwarding_rule" "cloudsql_psc" {',
        '  name                  = "${local.name}-cloudsql-psc"',
        '  region                = var.region',
        '  network               = ' + netRef(c),
        '  ip_address            = google_compute_address.cloudsql_psc.id',
        '  load_balancing_scheme = ""',
        '  target                = google_sql_database_instance.state.psc_service_attachment_link',
        '}'
      ]).join('\n'));
    }
    if (c.redisManaged) {
      var redisKms = c.cmek ? ['  kms_key                     = google_kms_crypto_key.key.id'] : [];
      var redisDeps = ['google_network_connectivity_service_connection_policy.redis', 'google_project_service.enabled'];
      if (c.cmek) redisDeps.push('google_kms_crypto_key_iam_member.redis');
      B.push([
        '# Memorystore (Redis Cluster) over PSC service connectivity automation: the hot',
        '# state tier and/or the response cache.',
        'resource "google_network_connectivity_service_connection_policy" "redis" {',
        '  name          = "${local.name}-redis-scp"',
        '  location      = var.region',
        '  service_class = "gcp-memorystore-redis"',
        '  network       = ' + netRef(c),
        '  psc_config {',
        '    subnetworks = [data.google_compute_subnetwork.psc.id]',
        '  }',
        DEP,
        '}',
        '',
        'resource "google_redis_cluster" "cache" {',
        '  name                        = "${local.name}-cache"',
        '  shard_count                 = var.redis_shard_count',
        '  node_type                   = "REDIS_SHARED_CORE_NANO"',
        '  region                      = var.region',
        '  deletion_protection_enabled = false',
        '  psc_configs {',
        '    network = ' + netRef(c),
        '  }'
      ].concat(redisKms).concat([
        '  depends_on = [' + redisDeps.join(', ') + ']',
        '}'
      ]).join('\n'));
    }

    /* BigQuery: feedback/evals dataset; durable audit history for automation */
    var bqEnc = c.cmek ? ['  default_encryption_configuration {', '    kms_key_name = google_kms_crypto_key.key.id', '  }'] : [];
    var bqDep = c.cmek ? '  depends_on = [google_project_service.enabled, google_kms_crypto_key_iam_member.bigquery]' : DEP;
    B.push([
      'resource "google_bigquery_dataset" "feedback" {',
      '  dataset_id                 = replace("${local.name}_feedback", "-", "_")',
      '  location                   = var.region',
      '  labels                     = var.labels',
      '  delete_contents_on_destroy = true'
    ].concat(bqEnc).concat([
      bqDep,
      '}'
    ]).join('\n'));

    /* automation eventing */
    if (c.automation) {
      B.push([
        'resource "google_pubsub_topic" "trigger" {',
        '  name = "${local.name}-trigger"',
        DEP,
        '}',
        '',
        'resource "google_pubsub_topic" "dlq" {',
        '  name = "${local.name}-dlq"',
        DEP,
        '}',
        '',
        'resource "google_pubsub_subscription" "trigger" {',
        '  name  = "${local.name}-trigger-sub"',
        '  topic = google_pubsub_topic.trigger.name',
        '  dead_letter_policy {',
        '    dead_letter_topic     = google_pubsub_topic.dlq.id',
        '    max_delivery_attempts = 5',
        '  }',
        '}',
        '',
        'locals {',
        '  pubsub_sa = "serviceAccount:service-${data.google_project.this.number}@gcp-sa-pubsub.iam.gserviceaccount.com"',
        '}',
        '',
        'resource "google_pubsub_topic_iam_member" "dlq_publisher" {',
        '  topic  = google_pubsub_topic.dlq.name',
        '  role   = "roles/pubsub.publisher"',
        '  member = local.pubsub_sa',
        '}',
        '',
        'resource "google_pubsub_subscription_iam_member" "trigger_subscriber" {',
        '  subscription = google_pubsub_subscription.trigger.name',
        '  role         = "roles/pubsub.subscriber"',
        '  member       = local.pubsub_sa',
        '}'
      ].join('\n'));
    }

    /* Secret Manager: ONLY the Redis-on-GKE AUTH credential (v2 invariant) */
    if (c.secretManagerOn) {
      B.push([
        inline('redis-auth'),
        'resource "google_secret_manager_secret" "redis_auth" {',
        '  secret_id = "${local.name}-redis-auth"',
        '  replication {',
        '    auto {}',
        '  }',
        DEP,
        '}'
      ].join('\n'));
    }

    /* observability and governance */
    if (c.auditLog) {
      B.push([
        inline('note-worm'),
        'resource "google_logging_project_bucket_config" "audit" {',
        '  project        = var.project_id',
        '  location       = var.region',
        '  bucket_id      = "${local.name}-audit"',
        '  retention_days = 1095',
        '  locked         = false',
        '}'
      ].join('\n'));
    }
    if (c.dataAccessAudit) {
      B.push([
        '# Data Access audit logs across the managed stores (Admin Activity is always on).',
        'resource "google_project_iam_audit_config" "data_access" {',
        '  project = var.project_id',
        '  service = "allServices"',
        '  audit_log_config {',
        '    log_type = "DATA_READ"',
        '  }',
        '  audit_log_config {',
        '    log_type = "DATA_WRITE"',
        '  }',
        '}'
      ].join('\n'));
    }

    /* self-hosted inference fleet (vLLM on GKE Standard with a GPU pool) */
    if (c.selfHost) {
      var accel = { h100: ['a3-highgpu-1g', 'nvidia-h100-80gb'], b200: ['a4-highgpu-8t', 'nvidia-b200'], tpu: ['a3-highgpu-1g', 'nvidia-h100-80gb'] }[c.accelerator] || ['a3-highgpu-1g', 'nvidia-h100-80gb'];
      B.push([
        inline('vllm-deploy'),
        '# Self-hosted open-weights serving (vLLM). Size the fleet with the serving calculator;',
        '# the node pool here is the minimal starting point.' + (c.accelerator === 'tpu' ? ' TPU pools use a different node' : ''),
        (c.accelerator === 'tpu' ? '# config (ct6e machine types + tpu_topology); the GPU pool below is the GPU fallback.' : ''),
        'resource "google_container_cluster" "inference" {',
        '  name                = "${local.name}-inference"',
        '  location            = var.region',
        '  initial_node_count  = 1',
        '  deletion_protection = false',
        '  network             = ' + netName(c),
        '  ip_allocation_policy {}',
        DEP,
        '}',
        '',
        'resource "google_container_node_pool" "gpu" {',
        '  name       = "gpu"',
        '  cluster    = google_container_cluster.inference.id',
        '  node_count = var.gpu_node_count',
        '  node_config {',
        '    machine_type = ' + q(accel[0]),
        '    guest_accelerator {',
        '      type  = ' + q(accel[1]),
        '      count = 1',
        '    }',
        '    oauth_scopes = ["https://www.googleapis.com/auth/cloud-platform"]',
        '  }',
        '}'
      ].filter(Boolean).join('\n'));
    }

    /* hybrid bridge: cloud-side only, every piece gated on tfvars */
    if (c.hybrid) {
      B.push([
        '# Cloud Router that peers with your on-prem edge over the interconnect.',
        'resource "google_compute_router" "onprem" {',
        '  count   = var.onprem_interconnect == "" ? 0 : 1',
        '  name    = "${local.name}-cr"',
        '  region  = var.region',
        '  network = ' + netName(c),
        '  bgp {',
        '    asn = var.cloud_router_asn',
        '  }',
        DEP,
        '}',
        '',
        inline('bgp-peer'),
        'resource "google_compute_interconnect_attachment" "onprem" {',
        '  count        = var.onprem_interconnect == "" ? 0 : 1',
        '  name         = "${local.name}-vlan"',
        '  region       = var.region',
        '  type         = "DEDICATED"',
        '  router       = google_compute_router.onprem[0].id',
        '  interconnect = var.onprem_interconnect',
        '}',
        '',
        'resource "google_compute_router_interface" "onprem" {',
        '  count                   = var.onprem_interconnect == "" ? 0 : 1',
        '  name                    = "${local.name}-if"',
        '  region                  = var.region',
        '  router                  = google_compute_router.onprem[0].name',
        '  interconnect_attachment = google_compute_interconnect_attachment.onprem[0].name',
        '}',
        '',
        'resource "google_compute_firewall" "allow_onprem" {',
        '  count         = length(var.onprem_cidrs) > 0 ? 1 : 0',
        '  name          = "${local.name}-allow-onprem"',
        '  network       = ' + netName(c),
        '  direction     = "INGRESS"',
        '  source_ranges = var.onprem_cidrs',
        '  allow {',
        '    protocol = "tcp"',
        '    ports    = ["80", "443", "8080"]',
        '  }',
        DEP,
        '}',
        '',
        'resource "google_dns_managed_zone" "onprem_forward" {',
        '  count       = var.onprem_dns_domain != "" && length(var.onprem_dns_servers) > 0 ? 1 : 0',
        '  name        = "${local.name}-onprem"',
        '  dns_name    = var.onprem_dns_domain',
        '  description = "Forward on-prem domain resolution across the interconnect."',
        '  visibility  = "private"',
        '  private_visibility_config {',
        '    networks {',
        '      network_url = ' + netRef(c),
        '    }',
        '  }',
        '  forwarding_config {',
        '    dynamic "target_name_servers" {',
        '      for_each = toset(var.onprem_dns_servers)',
        '      content {',
        '        ipv4_address = target_name_servers.value',
        '      }',
        '    }',
        '  }',
        DEP,
        '}'
      ].join('\n'));
    }

    /* VPC-SC perimeter, gated on the org-level access policy */
    if (c.vpcsc) {
      var restricted = ['aiplatform.googleapis.com', 'storage.googleapis.com', 'bigquery.googleapis.com'];
      if (c.vais) restricted.push('discoveryengine.googleapis.com');
      if (c.alloyAny) restricted.push('alloydb.googleapis.com');
      if (c.stateSpanner) restricted.push('spanner.googleapis.com');
      B.push([
        '# VPC Service Controls perimeter; created only when access_policy_id is set.',
        'resource "google_access_context_manager_service_perimeter" "perimeter" {',
        '  count  = var.access_policy_id == "" ? 0 : 1',
        '  parent = "accessPolicies/${var.access_policy_id}"',
        '  name   = "accessPolicies/${var.access_policy_id}/servicePerimeters/${replace(local.name, "-", "_")}"',
        '  title  = "${local.name}-perimeter"',
        '  status {',
        '    resources = ["projects/${data.google_project.this.number}"]',
        '    restricted_services = [',
        restricted.map(function (s) { return '      ' + q(s) + ','; }).join('\n'),
        '    ]',
        '  }',
        '}'
      ].join('\n'));
    }

    return B.join('\n\n') + '\n';
  }

  /* AlloyDB cluster + primary + consumer PSC endpoint, named by role. */
  function alloyCluster(c, role, noteLine) {
    var DEP = '  depends_on = [google_project_service.enabled]';
    var isState = role === 'state';
    var rn = isState ? 'state' : 'vectors';
    var pscName = isState ? 'alloydb_psc' : 'alloydb_vec_psc';
    var enc = c.cmek ? ['  encryption_config {', '    kms_key_name = google_kms_crypto_key.key.id', '  }'] : [];
    var deps = c.cmek ? 'google_project_service.enabled, google_kms_crypto_key_iam_member.alloydb' : 'google_project_service.enabled';
    return [
      '# AlloyDB (' + (isState ? 'state store' : 'vector store') + ') over PSC: the cluster publishes a service',
      '# attachment; the consumer endpoint below makes it reachable from the network.',
      noteLine,
      'resource "google_alloydb_cluster" "' + rn + '" {',
      '  cluster_id      = "${local.name}-' + rn + '"',
      '  location        = var.region',
      '  deletion_policy = "FORCE"',
      '  psc_config {',
      '    psc_enabled = true',
      '  }'
    ].concat(enc).concat([
      '  depends_on = [' + deps + ']',
      '}',
      '',
      'resource "google_alloydb_instance" "' + rn + '" {',
      '  cluster       = google_alloydb_cluster.' + rn + '.name',
      '  instance_id   = "${local.name}-' + rn + '-primary"',
      '  instance_type = "PRIMARY"',
      '  machine_config {',
      '    cpu_count = var.alloydb_cpu_count',
      '  }',
      '  psc_instance_config {',
      '    allowed_consumer_projects = [var.project_id]',
      '  }',
      '}',
      '',
      'resource "google_compute_address" "' + pscName + '" {',
      '  name         = "${local.name}-' + rn + '-psc"',
      '  region       = var.region',
      '  subnetwork   = data.google_compute_subnetwork.psc.id',
      '  address_type = "INTERNAL"',
      '}',
      '',
      'resource "google_compute_forwarding_rule" "' + pscName + '" {',
      '  name                  = "${local.name}-' + rn + '-psc"',
      '  region                = var.region',
      '  network               = ' + netRef(c),
      '  ip_address            = google_compute_address.' + pscName + '.id',
      '  load_balancing_scheme = ""',
      '  target                = google_alloydb_instance.' + rn + '.psc_instance_config[0].service_attachment_link',
      '}'
    ]).filter(Boolean).join('\n');
  }

  function outputsTf(c) {
    var outs = [
      ['data_bucket', 'google_storage_bucket.data.name', 'Bucket holding documents, artifacts, and index staging.']
    ];
    if (c.docCorpus || c.website) outs.push(['seed_docs_uri', '"gs://${google_storage_bucket.data.name}/seed-docs/"', 'Upload your source documents here, then import them.']);
    if (c.runtime === 'agentengine') {
      outs.push(['agent_url', 'google_cloud_run_v2_service.api.uri', 'Cloud Run URL of the agent service.']);
      if (c.publicGateway) outs.push(['api_gateway_host', 'google_api_gateway_gateway.gw.default_hostname', 'Public hostname of the API gateway.']);
    } else if (c.gke) {
      outs.push(['agent_cluster', 'google_container_cluster.agent.name', 'GKE cluster hosting the agent.']);
      outs.push(['agent_endpoint', 'try(kubernetes_service_v1.agent.status[0].load_balancer[0].ingress[0].ip, "pending")', (c.privateOnly ? 'Internal' : 'External') + ' LoadBalancer IP of the agent service (after the second apply phase).']);
    }
    if (c.vpc) outs.push(['network', 'google_compute_network.vpc.name', 'Dedicated VPC network.']);
    if (c.hybrid) outs.push(['onprem_vlan_attachment', 'try(google_compute_interconnect_attachment.onprem[0].name, "not configured - set onprem_interconnect")', 'VLAN attachment bridging to your on-prem interconnect.']);
    if (c.vais && c.docCorpus) outs.push(['docs_data_store', 'google_discovery_engine_data_store.docs.data_store_id', 'Document corpus data store id.']);
    if (c.vais && c.website) outs.push(['site_data_store', 'google_discovery_engine_data_store.site.data_store_id', 'Owned site data store id.']);
    if (c.vectorVertex) {
      outs.push(['vector_index', 'google_vertex_ai_index.vectors.name', 'Vector Search index resource name.']);
      outs.push(['vector_index_endpoint', 'google_vertex_ai_index_endpoint.vectors.name', 'Vector Search index endpoint resource name.']);
    }
    if (c.alloyAny) outs.push(['alloydb_psc_address', 'google_compute_address.' + (c.stateAlloy ? 'alloydb_psc' : 'alloydb_vec_psc') + '.address', 'PSC endpoint IP for AlloyDB.']);
    if (c.redisManaged) outs.push(['redis_endpoint', 'google_redis_cluster.cache.discovery_endpoints[0].address', 'Memorystore Redis Cluster discovery endpoint.']);
    var blocks = outs.map(function (o) {
      return ['output "' + o[0] + '" {', '  description = ' + q(o[2]), '  value       = ' + o[1], '}'].join('\n');
    });
    return blocks.join('\n\n') + '\n';
  }

  function readme(c, placeholders, steps) {
    var L = [];
    L.push('# Terraform bundle: ' + (c.automation ? 'task automation' : 'interactive assistant') + ' on Google Cloud');
    L.push('');
    L.push('Generated by the System Design tool from the design on the page. The architecture');
    L.push('is main.tf; the deploy specifics are terraform.tfvars.' + (c.answerOnly ? ' There is no agent/ code:' : ' The agent code in agent/ is'));
    L.push(c.answerOnly ? 'this no-agent design answers directly from Agent Search.' : 'generic: the task wording, models, and tool wiring come from configuration.');
    L.push('');
    L.push('## What this provisions');
    L.push('');
    if (c.answerOnly) L.push('- No agent: clients call the Agent Search answer API directly; the grounded answer is generated inside the service (see the answer-api step).');
    else if (c.runtime === 'agentengine') L.push('- The agent API on Cloud Run' + (c.publicGateway ? ' behind Cloud API Gateway' : (c.privateOnly ? ' with internal-only ingress (private-only hybrid topology)' : '')) + '; the Agent Runtime object itself is pushed with the ADK CLI after apply.');
    else L.push('- The agent on GKE Autopilot (Deployment + ' + (c.privateOnly ? 'internal ' : '') + 'LoadBalancer Service).');
    if (c.vais) L.push('- Agent Search data store(s) and a search engine per store for managed retrieval.');
    if (c.vectorVertex) L.push('- A Vector Search (managed ScaNN) index and endpoint for the self-built retrieval pipeline.');
    if (c.vectorAlloy) L.push('- AlloyDB as the vector store (ScaNN index via SQL after apply) for the self-built pipeline.');
    if (c.docai) L.push('- A Document AI OCR processor for ingestion parsing.');
    if (c.stateAlloy) L.push('- AlloyDB for agent state, reached over a Private Service Connect endpoint.');
    if (c.stateSpanner) L.push('- Spanner for agent state.');
    if (c.stateCloudSql) L.push('- Cloud SQL (PostgreSQL) for agent state, reached over PSC (public IP off).');
    if (c.redisManaged) L.push('- Memorystore for Redis Cluster (hot state tier and/or response cache) over PSC.');
    if (c.redisOnGke) L.push('- Self-hosted Redis in the cluster (hot state tier and/or response cache).');
    if (c.vpc) L.push('- A dedicated VPC wrapping the self-hosted compute' + (c.hybrid ? ' and the hybrid Cloud Router' : '') + '; managed stores connect over PSC endpoints, outside the VPC.');
    if (c.armor) L.push('- A Model Armor template screening prompts and responses.');
    if (c.cmek) L.push('- CMEK via Cloud KMS on the managed stores (GCS, state store, cache, BigQuery). Self-hosted stores use disk and app encryption.');
    if (c.vpcsc) L.push('- A VPC Service Controls perimeter (created only when access_policy_id is set).');
    if (c.auditLog) L.push('- A long-retention audit log bucket (WORM-grade once locked; see Notes).');
    if (c.dataAccessAudit) L.push('- Data Access audit logging across services.');
    if (c.automation) L.push('- Pub/Sub trigger topic with a dead-letter queue' + (c.hitl ? ' and a human-review Cloud Run surface' : '') + '.');
    if (c.selfHost) L.push('- A GKE Standard cluster with a GPU node pool for self-hosted (vLLM) inference.');
    if (c.hybrid) L.push('- The cloud-side bridge to your existing Cloud Interconnect (Cloud Router, VLAN attachment, firewall, private DNS), each piece gated on its tfvar.');
    L.push('- A Cloud Storage data bucket and a BigQuery feedback/evals dataset.');
    L.push('');
    L.push('## Before you apply');
    L.push('');
    var req = placeholders.filter(function (p) { return p.kind === 'required'; });
    var gated = placeholders.filter(function (p) { return p.kind === 'gated'; });
    var review = placeholders.filter(function (p) { return p.kind === 'review'; });
    L.push('Required (terraform plan stops until these are set in terraform.tfvars):');
    L.push('');
    req.forEach(function (p) { L.push('- `' + p.var + '`: ' + p.why + (p.whereToGet ? ' (' + p.whereToGet + ')' : '')); });
    if (gated.length) {
      L.push('');
      L.push('Optional feature gates (empty = that piece is skipped and the plan stays clean):');
      L.push('');
      gated.forEach(function (p) { L.push('- `' + p.var + '`: gates ' + p.gatesWhat + '. ' + p.why + (p.whereToGet ? ' (' + p.whereToGet + ')' : '')); });
    }
    L.push('');
    L.push('Review before real use (safe defaults):');
    L.push('');
    review.forEach(function (p) { L.push('- `' + p.var + '`: ' + p.why); });
    var before = steps.filter(function (s) { return s.when === 'before-apply' && s.kind === 'step'; });
    if (before.length) {
      L.push('');
      L.push('Manual steps before apply:');
      before.forEach(function (s) { L.push(''); L.push('### ' + s.title); L.push(''); L.push(s.detail); });
    }
    L.push('');
    L.push('## Apply');
    L.push('');
    L.push('```');
    L.push('terraform fmt');
    L.push('terraform init');
    if (c.gke) {
      L.push('# Two-phase apply: the kubernetes provider needs the cluster first.');
      L.push('terraform apply -target=google_container_cluster.agent');
      L.push('terraform apply');
    } else {
      L.push('terraform plan');
      L.push('terraform apply');
    }
    L.push('```');
    L.push('');
    L.push('If a resource fails with an API-not-enabled error on the very first apply, wait a');
    L.push('minute and re-run apply; API enablement takes a moment to propagate.');
    var after = steps.filter(function (s) { return s.when === 'after-apply' && s.kind === 'step'; });
    if (after.length) {
      L.push('');
      L.push('## After apply');
      after.forEach(function (s) { L.push(''); L.push('### ' + s.title); L.push(''); L.push(s.detail); });
    }
    var notes = steps.filter(function (s) { return s.kind === 'note'; });
    if (notes.length) {
      L.push('');
      L.push('## Notes');
      notes.forEach(function (s) { L.push(''); L.push('- **' + s.title + '.** ' + s.detail.replace(/\n+/g, ' ')); });
    }
    return L.join('\n') + '\n';
  }

  /* ---------- agent skeleton: ADK-shaped, env-driven, pattern-aware ---------- */
  function agentPy(c) {
    return [
      '"""ADK agent skeleton generated by the System Design tool.',
      '',
      'Pattern: ' + c.pattern + '. In the multi-agent pattern the Orchestrator dispatches every',
      'hand-off: a Retriever owns the data tools, a Generator drafts, a Validator gates',
      'quality, and the revise loop is capped by REACT_MAX_ITER. A single-agent design',
      'keeps everything on one Generator. Wording, model ids, and tool wiring come from',
      'the environment, set by Terraform; this file assumes nothing about the domain.',
      '"""',
      'import os',
      '',
      'from google.adk.agents import LlmAgent',
      '',
      'PATTERN = os.environ.get("AGENT_PATTERN", "single")',
      'REACT_MAX_ITER = int(os.environ.get("REACT_MAX_ITER", "6"))',
      'GENERATION_MODEL = os.environ.get("GENERATION_MODEL", "gemini-3.5-flash")',
      'VALIDATION_MODEL = os.environ.get("VALIDATION_MODEL", GENERATION_MODEL)',
      'GENERATION_INSTRUCTION = os.environ.get("GENERATION_INSTRUCTION", "")',
      'VALIDATION_INSTRUCTION = os.environ.get("VALIDATION_INSTRUCTION", "")',
      'DATASTORE_ID = os.environ.get("GROUNDING_DATASTORE_ID", "")',
      '',
      '',
      'def _data_tools():',
      '    """Retrieval tools, wired from the environment. Extend with your live sources."""',
      '    tools = []',
      '    if DATASTORE_ID:',
      '        from google.adk.tools import VertexAiSearchTool',
      '        project = os.environ.get("GOOGLE_CLOUD_PROJECT", "")',
      '        tools.append(VertexAiSearchTool(data_store_id=(',
      '            f"projects/{project}/locations/global/collections/"',
      '            f"default_collection/dataStores/{DATASTORE_ID}"',
      '        )))',
      '    return tools',
      '',
      '',
      'def build_agent():',
      '    if PATTERN != "multi":',
      '        return LlmAgent(',
      '            name="generator",',
      '            model=GENERATION_MODEL,',
      '            instruction=GENERATION_INSTRUCTION,',
      '            tools=_data_tools(),',
      '        )',
      '    retriever = LlmAgent(',
      '        name="retriever",',
      '        model=VALIDATION_MODEL,',
      '        instruction="Execute the retrieval and live-data calls you are dispatched and "',
      '                    "return grounded context. Do not draft answers.",',
      '        tools=_data_tools(),',
      '    )',
      '    generator = LlmAgent(',
      '        name="generator",',
      '        model=GENERATION_MODEL,',
      '        instruction=GENERATION_INSTRUCTION,',
      '    )',
      '    validator = LlmAgent(',
      '        name="validator",',
      '        model=VALIDATION_MODEL,',
      '        instruction=VALIDATION_INSTRUCTION,',
      '    )',
      '    return LlmAgent(',
      '        name="orchestrator",',
      '        model=GENERATION_MODEL,',
      '        instruction=(',
      '            "Decompose the request. Send data fetching to the retriever, drafting to "',
      '            "the generator, and every draft to the validator. On REVISE, re-invoke "',
      f_iter(),
      '        ),',
      '        sub_agents=[retriever, generator, validator],',
      '    )',
      '',
      '',
      'root_agent = build_agent()',
      ''
    ].join('\n');
    function f_iter() {
      return '            f"the generator with the critique, at most {REACT_MAX_ITER} times."';
    }
  }

  function requirementsTxt() {
    return ['google-adk>=1.0.0', 'google-cloud-aiplatform>=1.95.0', ''].join('\n');
  }
  function dockerfile() {
    return [
      'FROM python:3.12-slim',
      'WORKDIR /app',
      'COPY requirements.txt .',
      'RUN pip install --no-cache-dir -r requirements.txt',
      'COPY . .',
      'ENV PORT=8080',
      'CMD ["adk", "api_server", "--host", "0.0.0.0", "--port", "8080", "/app"]',
      ''
    ].join('\n');
  }

  /* Align '=' across runs of consecutive attribute lines at the same indent,
     one space past the longest name - the same rule terraform fmt applies - so
     the emitted files are fmt-canonical as generated. Comments, blank lines,
     block delimiters, and heredoc bodies break a run, exactly like fmt. */
  function alignTf(src) {
    var lines = src.split('\n');
    var out = lines.slice();
    var group = [];
    var inHeredoc = false;
    var ATTR = /^(\s*)((?:"[^"]+")|(?:[A-Za-z_][\w-]*))\s+=\s+(.*)$/;
    function flush() {
      if (group.length > 1) {
        var w = Math.max.apply(null, group.map(function (g) { return g.name.length; }));
        group.forEach(function (g) {
          out[g.idx] = g.indent + g.name + new Array(w - g.name.length + 1).join(' ') + ' = ' + g.val;
        });
      }
      group = [];
    }
    lines.forEach(function (ln, i) {
      if (inHeredoc) { if (/^\s*EOT\s*$/.test(ln)) inHeredoc = false; return; }
      if (/<<-?EOT/.test(ln)) { inHeredoc = true; flush(); return; }
      var m = /^\s*#/.test(ln) ? null : ln.match(ATTR);
      if (m) {
        /* An attribute whose value opens a multi-line list/object does not join
           an alignment group (fmt gives it a single-space '='). */
        var bare = m[3].replace(/"(?:[^"\\]|\\.)*"/g, '""');
        var opens = (bare.match(/[\[{(]/g) || []).length;
        var closes = (bare.match(/[\]})]/g) || []).length;
        if (opens > closes) { flush(); out[i] = m[1] + m[2] + ' = ' + m[3]; return; }
        if (group.length && group[0].indent !== m[1]) flush();
        group.push({ idx: i, indent: m[1], name: m[2], val: m[3] });
      } else flush();
    });
    flush();
    return out.join('\n');
  }

  function generate(arch, inputs) {
    var c = ctx(arch, inputs);
    var placeholders = placeholdersFor(c);
    var steps = stepsFor(c);
    var files = {};
    files['versions.tf'] = alignTf(versionsTf(c));
    files['variables.tf'] = alignTf(variablesTf(c));
    files['terraform.tfvars'] = alignTf(tfvarsFile(c, placeholders));
    files['main.tf'] = alignTf(mainTf(c));
    files['outputs.tf'] = alignTf(outputsTf(c));
    files['README.md'] = readme(c, placeholders, steps);
    if (!c.answerOnly) {
      files['agent/agent.py'] = agentPy(c);
      files['agent/requirements.txt'] = requirementsTxt();
      files['agent/Dockerfile'] = dockerfile();
    }
    return { files: files, placeholders: placeholders, steps: steps, ctx: c };
  }

  /* ---------- store-only zip (no compression, no library) ---------- */
  function crc32(bytes) {
    var crc = -1;
    for (var i = 0; i < bytes.length; i++) {
      var ch = (crc ^ bytes[i]) & 0xff;
      for (var k = 0; k < 8; k++) ch = (ch & 1) ? (ch >>> 1) ^ 0xEDB88320 : ch >>> 1;
      crc = (crc >>> 8) ^ ch;
    }
    return (crc ^ -1) >>> 0;
  }
  function zip(files) {
    var enc = new TextEncoder();
    var u16 = function (n) { return [n & 0xff, (n >>> 8) & 0xff]; };
    var u32 = function (n) { return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]; };
    var DOSDATE = 0x21, DOSTIME = 0;
    var chunks = [], central = [], offset = 0;
    var names = Object.keys(files);
    names.forEach(function (name) {
      var nameBytes = enc.encode(name);
      var data = typeof files[name] === 'string' ? enc.encode(files[name]) : files[name];
      var crc = crc32(data);
      var lfh = [].concat(
        u32(0x04034b50), u16(20), u16(0), u16(0), u16(DOSTIME), u16(DOSDATE),
        u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0)
      );
      chunks.push(Uint8Array.from(lfh), nameBytes, data);
      var cdh = [].concat(
        u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(DOSTIME), u16(DOSDATE),
        u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length),
        u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset)
      );
      central.push({ head: Uint8Array.from(cdh), name: nameBytes });
      offset += lfh.length + nameBytes.length + data.length;
    });
    var cdStart = offset, cdSize = 0;
    central.forEach(function (cn) { chunks.push(cn.head, cn.name); cdSize += cn.head.length + cn.name.length; });
    var eocd = [].concat(
      u32(0x06054b50), u16(0), u16(0), u16(names.length), u16(names.length),
      u32(cdSize), u32(cdStart), u16(0)
    );
    chunks.push(Uint8Array.from(eocd));
    var total = 0; chunks.forEach(function (cn) { total += cn.length; });
    var out = new Uint8Array(total), p = 0;
    chunks.forEach(function (cn) { out.set(cn, p); p += cn.length; });
    return out;
  }

  NS.tfgen = { generate: generate, zip: zip, MODEL_MAP: MODEL_MAP, STEP_TEXT: STEP_TEXT };
})(typeof window !== 'undefined' ? (window.ASD2 = window.ASD2 || {}) : (globalThis.ASD2 = globalThis.ASD2 || {}));
