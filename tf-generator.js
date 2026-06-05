/* tf-generator.js
 * Turn a design spec from agentic-system-designer.html into a deployable Terraform / HCL bundle.
 * Framework-free, no DOM, no network. Exposes window.TfGen = { generate, zip }.
 *
 * generate(spec) returns { files: { "main.tf": "...", "agent/agent.py": "...", ... } }.
 * zip(files) returns a Uint8Array (store-only zip, no compression, no external library).
 *
 * Runtime split:
 *   - Agent Engine runtime: agent on Cloud Run behind an API gateway; managed Vertex AI Search and
 *     Memorystore. A reasoning engine is also provisioned as the managed Agent Engine target.
 *   - GKE runtime: agent in-cluster (Deployment + LoadBalancer Service). Vector search (Elasticsearch)
 *     and the response cache (Redis) can be self-hosted in the same cluster so the agent reaches them
 *     over in-cluster DNS. Two-phase apply (cluster first).
 *
 * Scope: Google Cloud only. The Hybrid deployment additionally emits the cloud-side bridge to an
 * existing Cloud Interconnect (Cloud Router, VLAN attachment, firewall, private DNS), gated on tfvars;
 * the on-prem database itself is still the customer's. The agent code is generic: the task wording,
 * the grounding source, and the model ids come from config, not from the code.
 *
 * Style constraint: plain ASCII only in everything this file emits. No long dash, no curly quote,
 * no ellipsis.
 */
(function () {
  'use strict';

  var MODEL_MAP = {
    'gemini-3-pro': 'gemini-2.5-pro',
    'gemini-35-flash': 'gemini-2.5-flash',
    'gemini-31-flash-lite': 'gemini-2.5-flash-lite',
    'claude-opus-48': 'claude-opus-4-1',
    'llama4-selfhost': 'llama-4-self-host'
  };
  function realModel(id) { return MODEL_MAP[id] || id || 'gemini-2.5-flash'; }

  function q(s) { return '"' + String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'; }
  function hostOf(url) {
    var s = String(url || '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
    return s || 'example.com';
  }
  function uriPattern(url) { return hostOf(url) + '/*'; }
  function slug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'agent'; }

  function norm(spec) {
    spec = spec || {};
    var d = spec.deploy || {};
    var a = spec.agent || {};
    var r = spec.retrieval || {};
    var st = spec.state || {};
    var sec = spec.security || {};
    var au = spec.automation || {};
    var task = spec.task || {};
    var s = {
      purpose: spec.purpose || 'assistant',
      projectId: d.projectId || 'my-gcp-project',
      region: d.region || 'us-central1',
      prefix: slug(d.prefix || 'whiz-study'),
      env: slug(d.env || 'dev'),
      siteUrl: d.siteUrl || 'https://whiz.coach/',
      generationInstruction: task.generationInstruction || 'Generate a clear, accurate text answer on the given topic.',
      validationInstruction: task.validationInstruction || 'Check the text is accurate, on topic, and free of personal data. Reply APPROVE or REVISE with a reason.',
      runtime: a.runtime === 'gke' ? 'gke' : 'agentengine',
      framework: a.framework || 'adk',
      pattern: a.pattern || 'multi',
      numAgents: a.numAgents || 4,
      reasoningModel: realModel((a.reasoningModel || {}).id),
      fastModel: realModel((a.fastModel || {}).id),
      smartRouting: !!a.smartRouting,
      selfHost: !!a.selfHost,
      selfHostCfg: a.selfHostCfg || { accelerator: 'h100', quant: 'fp8', gpuTier: 'cud_3y', gpuUtil: 70 },
      retrievalOn: !!r.enabled,
      ragEngine: r.ragEngine || 'vais',
      vectorDB: r.vectorDB || 'vertex',
      dataSources: r.dataSources || [],
      hasWebsite: !!r.hasWebsite,
      hasUnstructured: !!r.hasUnstructured,
      hasOnprem: !!r.hasOnprem,
      hasLive: !!r.hasLive,
      stateStore: st.store || 'alloydb',
      needsRedis: !!st.needsRedis,
      isAutomation: !!au.isAutomation,
      dlq: au.dlq !== false,
      cmek: !!sec.cmek,
      enforceVpcSc: !!sec.enforceVpcSc,
      residencyPin: !!sec.residencyPin,
      auditLog: sec.auditLog !== false,
      guardrails: !!sec.guardrails,
      modelArmor: sec.modelArmor !== false,
      dedicatedVpc: spec.dedicatedVpc !== false
    };
    // derived deployment shape
    // Hybrid is a connectivity mode: the same managed system plus a cloud-side bridge to an existing
    // Cloud Interconnect (Cloud Router + VLAN attachment + firewall + private DNS), so on-premise users
    // can reach the system and it can reach on-prem systems. It needs a VPC to attach the router to.
    s.hybrid = spec.deployment === 'hybrid';
    s.gke = s.runtime === 'gke';
    s.selfHostSearch = s.retrievalOn && s.ragEngine === 'selfbuilt' && s.vectorDB === 'elastic' && s.gke;
    s.selfHostCache = s.gke && s.needsRedis;
    s.managedSearch = s.retrievalOn && (s.hasUnstructured || s.hasWebsite) && !s.selfHostSearch;
    s.managedRedis = s.needsRedis && !s.selfHostCache;
    return s;
  }

  function usesAlloy(s) { return s.stateStore.indexOf('alloydb') >= 0; }
  function usesSpanner(s) { return s.stateStore === 'spanner' || s.stateStore.indexOf('redis_spanner') >= 0; }
  function usesCloudSql(s) { return s.stateStore === 'cloudsql'; }
  function networkUser(s) { return usesAlloy(s) || s.managedRedis || s.gke || s.selfHost || s.hybrid; }
  function createVpc(s) { return (s.dedicatedVpc || s.hybrid) && networkUser(s); }   // hybrid always needs a VPC for the Cloud Router
  function netName(s) { return createVpc(s) ? 'google_compute_network.vpc.id' : '"default"'; }                                   // GKE network field (name or self-link)
  function netRef(s) { return createVpc(s) ? 'google_compute_network.vpc.id' : '"projects/${var.project_id}/global/networks/default"'; } // AlloyDB / Redis / PSA (full network id)

  function apiList(s) {
    var apis = [
      'aiplatform.googleapis.com',
      'storage.googleapis.com',
      'secretmanager.googleapis.com',
      'logging.googleapis.com',
      'cloudtrace.googleapis.com',
      'bigquery.googleapis.com',
      'iam.googleapis.com'
    ];
    if (s.managedSearch) apis.push('discoveryengine.googleapis.com');
    if (s.runtime === 'agentengine' || s.isAutomation) apis.push('run.googleapis.com');
    if (s.runtime === 'agentengine') { apis.push('apigateway.googleapis.com'); apis.push('servicemanagement.googleapis.com'); apis.push('servicecontrol.googleapis.com'); }
    if (s.modelArmor) apis.push('modelarmor.googleapis.com');
    if (usesAlloy(s)) apis.push('alloydb.googleapis.com');
    if (usesSpanner(s)) apis.push('spanner.googleapis.com');
    if (usesCloudSql(s)) apis.push('sqladmin.googleapis.com');
    if (s.managedRedis) apis.push('redis.googleapis.com');
    if (s.isAutomation) apis.push('pubsub.googleapis.com');
    if (s.cmek) apis.push('cloudkms.googleapis.com');
    if (s.enforceVpcSc) apis.push('accesscontextmanager.googleapis.com');
    if (s.gke || s.selfHost) apis.push('container.googleapis.com');
    if (networkUser(s)) apis.push('compute.googleapis.com');
    if (usesAlloy(s)) apis.push('servicenetworking.googleapis.com');
    if (s.hybrid) apis.push('dns.googleapis.com');
    return apis;
  }

  function versionsTf(s) {
    var providers = [
      '    google = {',
      '      source  = "hashicorp/google"',
      '      version = ">= 5.40.0"',
      '    }',
      '    google-beta = {',
      '      source  = "hashicorp/google-beta"',
      '      version = ">= 5.40.0"',
      '    }',
      '    archive = {',
      '      source  = "hashicorp/archive"',
      '      version = ">= 2.4.0"',
      '    }'
    ];
    if (s.gke) {
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
    if (s.gke) {
      out.push('');
      out.push('data "google_client_config" "default" {}');
      out.push('');
      out.push('# The kubernetes provider reads the cluster created in this same config. Because the');
      out.push('# cluster must exist before the provider can connect, apply in two phases: first');
      out.push('# target the cluster, then apply the rest. See the README.');
      out.push('provider "kubernetes" {');
      out.push('  host                   = "https://${google_container_cluster.agent.endpoint}"');
      out.push('  token                  = data.google_client_config.default.access_token');
      out.push('  cluster_ca_certificate = base64decode(google_container_cluster.agent.master_auth[0].cluster_ca_certificate)');
      out.push('}');
    }
    return out.join('\n') + '\n';
  }

  function variablesTf(s) {
    var blocks = [];
    function v(name, type, def, desc) {
      var b = ['variable "' + name + '" {'];
      b.push('  description = ' + q(desc));
      b.push('  type        = ' + type);
      if (def !== undefined) b.push('  default     = ' + def);
      b.push('}');
      blocks.push(b.join('\n'));
    }
    v('project_id', 'string', undefined, 'Target Google Cloud project id.');
    v('region', 'string', q(s.region), 'Primary region for regional resources.');
    v('name_prefix', 'string', q(s.prefix), 'Prefix for resource names.');
    v('environment', 'string', q(s.env), 'Environment label, for example dev or prod.');
    v('site_url', 'string', q(s.siteUrl), 'Owned site to index in Vertex AI Search.');
    v('generation_instruction', 'string', q(s.generationInstruction), 'System instruction for the generation step. Generic, set per deployment.');
    v('validation_instruction', 'string', q(s.validationInstruction), 'System instruction for the validation step.');
    v('generation_model', 'string', q(s.reasoningModel), 'Vertex model id for generation.');
    v('validation_model', 'string', q(s.fastModel), 'Vertex model id for validation.');
    v('gateway_image', 'string', q('us-docker.pkg.dev/cloudrun/container/hello'), 'Container image for the agent service. Replace with your build of the agent/ directory.');
    v('labels', 'map(string)', '{\n    managed-by = "agentic-system-designer"\n  }', 'Labels applied to resources that support them.');
    if (s.enforceVpcSc) v('access_policy_id', 'string', q(''), 'Access Context Manager access policy id (org or folder scoped). Set to create the VPC-SC perimeter; leave empty to deploy without it.');
    if (s.hybrid) {
      v('onprem_interconnect', 'string', q(''), 'Self-link of your existing Cloud Interconnect (Dedicated) to attach to. Leave empty to deploy without the on-prem link; set it to create the VLAN attachment and BGP session.');
      v('onprem_cidrs', 'list(string)', '[]', 'On-premise IP ranges allowed to reach the system over the interconnect. Empty disables the on-prem ingress firewall rule.');
      v('cloud_router_asn', 'number', '64514', 'BGP ASN for the Cloud Router that peers with your on-prem edge.');
      v('onprem_dns_domain', 'string', q(''), 'On-premise DNS domain to forward from the VPC (for example corp.example.com.). Needs onprem_dns_servers too; empty skips the private forwarding zone.');
      v('onprem_dns_servers', 'list(string)', '[]', 'On-premise DNS server IPs the forwarding zone targets. Empty skips the private forwarding zone.');
    }
    return blocks.join('\n\n') + '\n';
  }

  function tfvars(s) {
    var lines = [
      '# Filled from the designer export form. Edit project_id before apply.',
      'project_id             = ' + q(s.projectId),
      'region                 = ' + q(s.region),
      'name_prefix            = ' + q(s.prefix),
      'environment            = ' + q(s.env),
      'site_url               = ' + q(s.siteUrl),
      'generation_model       = ' + q(s.reasoningModel),
      'validation_model       = ' + q(s.fastModel),
      'generation_instruction = ' + q(s.generationInstruction),
      'validation_instruction = ' + q(s.validationInstruction)
    ];
    if (s.enforceVpcSc) lines.push('# access_policy_id     = "ACCESS_POLICY_NUMERIC_ID"  # set to create the VPC-SC perimeter');
    if (s.hybrid) {
      lines.push('# Hybrid on-prem link. Set these to connect the system to your existing Cloud Interconnect.');
      lines.push('# onprem_interconnect  = "projects/PROJECT/global/interconnects/NAME"  # existing interconnect self-link');
      lines.push('# onprem_cidrs         = ["10.0.0.0/8"]  # on-prem ranges allowed to reach the system');
      lines.push('# cloud_router_asn     = 64514');
      lines.push('# onprem_dns_domain    = "corp.example.com."');
      lines.push('# onprem_dns_servers   = ["10.0.0.53"]  # on-prem DNS server IPs to forward to');
    }
    return lines.join('\n') + '\n';
  }

  // env pairs the agent container reads; groundExpr is the Vertex data store id when managed search is used
  function agentEnvPairs(s, groundExpr) {
    var pairs = [
      ['GENERATION_INSTRUCTION', 'var.generation_instruction'],
      ['VALIDATION_INSTRUCTION', 'var.validation_instruction'],
      ['GENERATION_MODEL', 'var.generation_model'],
      ['VALIDATION_MODEL', 'var.validation_model'],
      ['GOOGLE_CLOUD_PROJECT', 'var.project_id'],
      ['GOOGLE_CLOUD_REGION', 'var.region']
    ];
    if (groundExpr) pairs.push(['GROUNDING_DATASTORE_ID', groundExpr]);
    if (s.selfHostSearch) { pairs.push(['ELASTICSEARCH_URL', q('http://elasticsearch:9200')]); pairs.push(['ELASTICSEARCH_INDEX', q('docs')]); }
    if (s.selfHostCache) pairs.push(['REDIS_URL', q('redis://redis:6379')]);
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

  function mainTf(s) {
    var B = [];
    var DEP = '  depends_on = [google_project_service.enabled]';

    B.push([
      'locals {',
      '  name             = "${var.name_prefix}-${var.environment}"',
      '  site_uri_pattern = "' + uriPattern(s.siteUrl) + '"',
      '}'
    ].join('\n'));

    if (s.isAutomation || s.enforceVpcSc) B.push('data "google_project" "this" {}');

    B.push([
      'resource "google_project_service" "enabled" {',
      '  for_each           = toset([',
      apiList(s).map(function (a) { return '    ' + q(a); }).join(',\n'),
      '  ])',
      '  service            = each.value',
      '  disable_on_destroy = false',
      '}'
    ].join('\n'));

    if (createVpc(s)) {
      B.push([
        'resource "google_compute_network" "vpc" {',
        '  name                    = "${local.name}-vpc"',
        '  auto_create_subnetworks = true',
        DEP,
        '}'
      ].join('\n'));
    }
    if (usesAlloy(s)) {
      B.push([
        '# Private Service Access range so AlloyDB can attach to the network',
        'resource "google_compute_global_address" "psa" {',
        '  name          = "${local.name}-psa"',
        '  purpose       = "VPC_PEERING"',
        '  address_type  = "INTERNAL"',
        '  prefix_length = 16',
        '  network       = ' + netRef(s),
        '}',
        '',
        'resource "google_service_networking_connection" "psa" {',
        '  network                 = ' + netRef(s),
        '  service                 = "servicenetworking.googleapis.com"',
        '  reserved_peering_ranges = [google_compute_global_address.psa.name]',
        '}'
      ].join('\n'));
    }

    B.push([
      'resource "google_service_account" "agent" {',
      '  account_id   = "${local.name}-agent"',
      '  display_name = "Agentic system agent runtime"',
      DEP,
      '}'
    ].join('\n'));
    var roles = ['roles/aiplatform.user', 'roles/storage.objectAdmin', 'roles/secretmanager.secretAccessor', 'roles/logging.logWriter', 'roles/cloudtrace.agent', 'roles/bigquery.dataEditor'];
    if (s.managedSearch) roles.splice(1, 0, 'roles/discoveryengine.editor');
    roles.forEach(function (role, i) {
      B.push([
        'resource "google_project_iam_member" "agent_' + i + '" {',
        '  project = var.project_id',
        '  role    = ' + q(role),
        '  member  = "serviceAccount:${google_service_account.agent.email}"',
        '}'
      ].join('\n'));
    });

    if (s.cmek) {
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
      // Grant every other managed store's service agent encrypt/decrypt on the key. service_identity
      // (google-beta) provisions the agent so the binding exists before the store is created; each
      // store then references the key (added per resource below). Self-hosted stores get no binding.
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
      if (usesAlloy(s)) B.push(kmsAgent('alloydb', 'alloydb.googleapis.com', '${google_project_service_identity.alloydb.email}'));
      if (usesSpanner(s)) B.push(kmsAgent('spanner', 'spanner.googleapis.com', '${google_project_service_identity.spanner.email}'));
      if (usesCloudSql(s)) B.push(kmsAgent('cloudsql', 'sqladmin.googleapis.com', '${google_project_service_identity.cloudsql.email}'));
      if (s.managedRedis) B.push(kmsAgent('redis', 'redis.googleapis.com', '${google_project_service_identity.redis.email}'));
      B.push('data "google_bigquery_default_service_account" "bq" {}\n\n' + kmsAgent('bigquery', null, '${data.google_bigquery_default_service_account.bq.email}'));
    }

    var enc = s.cmek ? ['  encryption {', '    default_kms_key_name = google_kms_crypto_key.key.id', '  }'].join('\n') : '';
    var bucketDep = s.cmek ? '  depends_on = [google_project_service.enabled, google_kms_crypto_key_iam_member.gcs]' : DEP;
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
    B.push([
      'resource "google_storage_bucket_object" "seed_docs_keep" {',
      '  name    = "seed-docs/.keep"',
      '  bucket  = google_storage_bucket.data.name',
      '  content = "Upload your source documents under the seed-docs/ prefix, then import them into the search index."',
      '}'
    ].join('\n'));
    B.push([
      'data "archive_file" "agent" {',
      '  type        = "zip"',
      '  source_dir  = "${path.module}/agent"',
      '  output_path = "${path.module}/build/agent.zip"',
      '}',
      '',
      'resource "google_storage_bucket_object" "agent_archive" {',
      '  name   = "agent/agent-${data.archive_file.agent.output_md5}.zip"',
      '  bucket = google_storage_bucket.data.name',
      '  source = data.archive_file.agent.output_path',
      '}',
      '',
      'resource "google_storage_bucket_object" "agent_requirements" {',
      '  name   = "agent/requirements.txt"',
      '  bucket = google_storage_bucket.data.name',
      '  source = "${path.module}/agent/requirements.txt"',
      '}'
    ].join('\n'));

    // managed Vertex AI Search (skipped when vector search is self-hosted on GKE)
    var groundExpr = null;
    if (s.managedSearch && s.hasUnstructured) {
      B.push([
        'resource "google_discovery_engine_data_store" "docs" {',
        '  location          = "global"',
        '  data_store_id     = "${local.name}-docs"',
        '  display_name      = "Unstructured docs"',
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
        '    search_tier = "SEARCH_TIER_STANDARD"',
        '  }',
        '}'
      ].join('\n'));
      groundExpr = 'google_discovery_engine_data_store.docs.data_store_id';
    }
    if (s.managedSearch && s.hasWebsite) {
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
        '# Owned site to crawl. Verify site ownership in the console before indexing.',
        'resource "google_discovery_engine_target_site" "owned" {',
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
        '    search_tier = "SEARCH_TIER_STANDARD"',
        '  }',
        '}'
      ].join('\n'));
      if (!groundExpr) groundExpr = 'google_discovery_engine_data_store.site.data_store_id';
    }

    if (s.modelArmor) {
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

    var pairs = agentEnvPairs(s, groundExpr);

    if (s.runtime === 'agentengine') {
      // serverless path: Cloud Run agent behind an API gateway, plus the managed Agent Engine target
      B.push([
        '# Vertex AI Agent Engine (reasoning engine). The supporting infra is provisioned here; push',
        '# the agent object with: adk deploy agent_engine --agent agent/  (Agent Engine packages the',
        '# code at build time, which Terraform cannot do). The bucket below holds the source artifact.',
        'resource "google_vertex_ai_reasoning_engine" "agent" {',
        '  provider     = google-beta',
        '  region       = var.region',
        '  display_name = "${local.name}-agent"',
        '  spec {',
        '    package_spec {',
        '      python_version        = "3.11"',
        '      pickle_object_gcs_uri = "gs://${google_storage_bucket.data.name}/${google_storage_bucket_object.agent_archive.name}"',
        '      requirements_gcs_uri  = "gs://${google_storage_bucket.data.name}/${google_storage_bucket_object.agent_requirements.name}"',
        '    }',
        '  }',
        DEP,
        '}'
      ].join('\n'));
      B.push([
        'resource "google_cloud_run_v2_service" "api" {',
        '  name                = "${local.name}-api"',
        '  location            = var.region',
        '  ingress             = "INGRESS_TRAFFIC_ALL"',
        '  deletion_protection = false',
        '  template {',
        '    service_account = google_service_account.agent.email',
        '    containers {',
        '      image = var.gateway_image',
        cloudRunEnv(pairs),
        '    }',
        '  }',
        DEP,
        '}',
        '',
        'resource "google_service_account" "gateway" {',
        '  account_id   = "${local.name}-gw"',
        '  display_name = "API Gateway backend invoker"',
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
        '      /generate:',
        '        post:',
        '          summary: Generate and validate text on a topic',
        '          operationId: generate',
        '          x-google-backend:',
        '            address: ${google_cloud_run_v2_service.api.uri}',
        '          responses:',
        '            "200":',
        '              description: ok',
        '  EOT',
        '}'
      ].join('\n'));
    } else {
      // GKE path: the agent runs in-cluster and is the entry point via a LoadBalancer Service.
      B.push([
        '# GKE Autopilot hosts the agent. Two-phase apply: create the cluster first, then the',
        '# kubernetes_* resources. See the README.',
        'resource "google_container_cluster" "agent" {',
        '  name                = "${local.name}-agent"',
        '  location            = var.region',
        '  enable_autopilot    = true',
        '  deletion_protection = false',
        '  network             = ' + netName(s),
        '  ip_allocation_policy {}',
        DEP,
        '}'
      ].join('\n'));
      if (s.selfHostSearch) {
        B.push([
          '# Self-hosted vector search: single-node Elasticsearch in the cluster. The agent reaches it',
          '# at http://elasticsearch:9200. Ingest the seed-docs into the index after apply (see README).',
          'resource "kubernetes_stateful_set_v1" "elasticsearch" {',
          '  metadata {',
          '    name   = "elasticsearch"',
          '    labels = { app = "elasticsearch" }',
          '  }',
          '  spec {',
          '    service_name = "elasticsearch"',
          '    replicas     = 1',
          '    selector {',
          '      match_labels = { app = "elasticsearch" }',
          '    }',
          '    template {',
          '      metadata {',
          '        labels = { app = "elasticsearch" }',
          '      }',
          '      spec {',
          '        container {',
          '          name  = "elasticsearch"',
          '          image = "docker.elastic.co/elasticsearch/elasticsearch:8.13.4"',
          '          env {',
          '            name  = "discovery.type"',
          '            value = "single-node"',
          '          }',
          '          env {',
          '            name  = "xpack.security.enabled"',
          '            value = "false"',
          '          }',
          '          env {',
          '            name  = "ES_JAVA_OPTS"',
          '            value = "-Xms1g -Xmx1g"',
          '          }',
          '          port {',
          '            container_port = 9200',
          '          }',
          '          resources {',
          '            requests = {',
          '              cpu    = "1"',
          '              memory = "2Gi"',
          '            }',
          '            limits = {',
          '              cpu    = "2"',
          '              memory = "3Gi"',
          '            }',
          '          }',
          '          volume_mount {',
          '            name       = "data"',
          '            mount_path = "/usr/share/elasticsearch/data"',
          '          }',
          '        }',
          '      }',
          '    }',
          '    volume_claim_template {',
          '      metadata {',
          '        name = "data"',
          '      }',
          '      spec {',
          '        access_modes = ["ReadWriteOnce"]',
          '        resources {',
          '          requests = {',
          '            storage = "10Gi"',
          '          }',
          '        }',
          '      }',
          '    }',
          '  }',
          '}',
          '',
          'resource "kubernetes_service_v1" "elasticsearch" {',
          '  metadata {',
          '    name = "elasticsearch"',
          '  }',
          '  spec {',
          '    selector = { app = "elasticsearch" }',
          '    port {',
          '      port        = 9200',
          '      target_port = 9200',
          '    }',
          '    type = "ClusterIP"',
          '  }',
          '}'
        ].join('\n'));
      }
      if (s.selfHostCache) {
        B.push([
          '# Self-hosted response cache: Redis in the cluster, reached at redis://redis:6379.',
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
      B.push([
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
        '          image = var.gateway_image',
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
        '  metadata {',
        '    name = "agent"',
        '  }',
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

    if (s.isAutomation) {
      B.push([
        '# Human-review surface for the quality gate (HITL). Replace the image with your review app.',
        'resource "google_cloud_run_v2_service" "review" {',
        '  name                = "${local.name}-review"',
        '  location            = var.region',
        '  deletion_protection = false',
        '  template {',
        '    service_account = google_service_account.agent.email',
        '    containers {',
        '      image = var.gateway_image',
        '    }',
        '  }',
        DEP,
        '}'
      ].join('\n'));
    }

    if (usesAlloy(s)) {
      var alloyEnc = s.cmek ? ['  encryption_config {', '    kms_key_name = google_kms_crypto_key.key.id', '  }'] : [];
      var alloyDeps = s.cmek ? 'google_service_networking_connection.psa, google_kms_crypto_key_iam_member.alloydb' : 'google_service_networking_connection.psa';
      B.push([
        'resource "google_alloydb_cluster" "state" {',
        '  cluster_id      = "${local.name}-state"',
        '  location        = var.region',
        '  deletion_policy = "FORCE"',
        '  network_config {',
        '    network = ' + netRef(s),
        '  }'
      ].concat(alloyEnc).concat([
        '  depends_on = [' + alloyDeps + ']',
        '}',
        '',
        'resource "google_alloydb_instance" "state" {',
        '  cluster       = google_alloydb_cluster.state.name',
        '  instance_id   = "${local.name}-primary"',
        '  instance_type = "PRIMARY"',
        '  machine_config {',
        '    cpu_count = 2',
        '  }',
        '}'
      ]).join('\n'));
    } else if (usesSpanner(s)) {
      var spanEnc = s.cmek ? ['  encryption_config {', '    kms_key_name = google_kms_crypto_key.key.id', '  }', '  depends_on = [google_kms_crypto_key_iam_member.spanner]'] : [];
      B.push([
        'resource "google_spanner_instance" "state" {',
        '  name             = "${local.name}-state"',
        '  config           = "regional-${var.region}"',
        '  display_name     = "Agent state"',
        '  processing_units = 100',
        DEP,
        '}',
        '',
        'resource "google_spanner_database" "state" {',
        '  instance = google_spanner_instance.state.name',
        '  name     = "agent"'
      ].concat(spanEnc).concat(['}']).join('\n'));
    } else if (usesCloudSql(s)) {
      var sqlEnc = s.cmek ? ['  encryption_key_name = google_kms_crypto_key.key.id'] : [];
      var sqlDep = s.cmek ? '  depends_on = [google_project_service.enabled, google_kms_crypto_key_iam_member.cloudsql]' : DEP;
      B.push([
        'resource "google_sql_database_instance" "state" {',
        '  name                = "${local.name}-state"',
        '  region              = var.region',
        '  database_version    = "POSTGRES_15"',
        '  deletion_protection = false'
      ].concat(sqlEnc).concat([
        '  settings {',
        '    tier = "db-custom-2-7680"',
        '  }',
        sqlDep,
        '}'
      ]).join('\n'));
    }

    if (s.managedRedis) {
      var redisEnc = s.cmek ? ['  customer_managed_key = google_kms_crypto_key.key.id'] : [];
      var redisDep = s.cmek ? '  depends_on = [google_project_service.enabled, google_kms_crypto_key_iam_member.redis]' : DEP;
      B.push([
        'resource "google_redis_instance" "cache" {',
        '  name               = "${local.name}-cache"',
        '  tier               = "BASIC"',
        '  memory_size_gb     = 1',
        '  region             = var.region',
        '  authorized_network = ' + netRef(s)
      ].concat(redisEnc).concat([
        redisDep,
        '}'
      ]).join('\n'));
    }

    var bqEnc = s.cmek ? ['  default_encryption_configuration {', '    kms_key_name = google_kms_crypto_key.key.id', '  }'] : [];
    var bqDep = s.cmek ? '  depends_on = [google_project_service.enabled, google_kms_crypto_key_iam_member.bigquery]' : DEP;
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

    if (s.isAutomation) {
      B.push([
        'resource "google_pubsub_topic" "trigger" {',
        '  name = "${local.name}-trigger"',
        DEP,
        '}',
        '',
        'resource "google_pubsub_topic" "dlq" {',
        '  name = "${local.name}-dlq"',
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
        '# The Pub/Sub service agent must publish to the DLQ and pull from the subscription',
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

    B.push([
      'resource "google_secret_manager_secret" "app" {',
      '  secret_id = "${local.name}-app"',
      '  replication {',
      '    auto {}',
      '  }',
      DEP,
      '}'
    ].join('\n'));
    if (s.hasOnprem) {
      B.push([
        '# On-prem database credential. The on-prem database and the network link (VPN or',
        '# Interconnect) are NOT provisioned by this Terraform. See the on-prem section of the README.',
        'resource "google_secret_manager_secret" "onprem_db" {',
        '  secret_id = "${local.name}-onprem-db"',
        '  replication {',
        '    auto {}',
        '  }',
        DEP,
        '}'
      ].join('\n'));
    }

    if (s.selfHost) {
      var accel = { h100: 'nvidia-h100-80gb', b200: 'nvidia-b200', tpu: 'nvidia-h100-80gb' }[s.selfHostCfg.accelerator] || 'nvidia-h100-80gb';
      B.push([
        '# Self-hosted open model served with vLLM on GKE. Separate from the agent runtime.',
        'resource "google_container_cluster" "inference" {',
        '  name                = "${local.name}-inference"',
        '  location            = var.region',
        '  initial_node_count  = 1',
        '  deletion_protection = false',
        '  network             = ' + netName(s),
        '  ip_allocation_policy {}',
        DEP,
        '}',
        '',
        'resource "google_container_node_pool" "gpu" {',
        '  name       = "gpu"',
        '  cluster    = google_container_cluster.inference.id',
        '  node_count = 1',
        '  node_config {',
        '    machine_type = "a3-highgpu-1g"',
        '    guest_accelerator {',
        '      type  = "' + accel + '"',
        '      count = 1',
        '    }',
        '    oauth_scopes = ["https://www.googleapis.com/auth/cloud-platform"]',
        '  }',
        '}'
      ].join('\n'));
    }

    if (s.hybrid) {
      // Cloud-side bridge to an existing Cloud Interconnect so on-premise users can reach the system
      // (and it can reach on-prem). Every resource is gated on its tfvars, so an unset bundle still
      // plans clean (count 0). The BGP peer - peer IP is allocated by the attachment, the on-prem ASN
      // is site-specific - is added per the README once the attachment is up.
      B.push([
        '# Cloud Router that peers with your on-prem edge over the interconnect.',
        'resource "google_compute_router" "onprem" {',
        '  count   = var.onprem_interconnect == "" ? 0 : 1',
        '  name    = "${local.name}-cr"',
        '  region  = var.region',
        '  network = ' + netName(s),
        '  bgp {',
        '    asn = var.cloud_router_asn',
        '  }',
        DEP,
        '}',
        '',
        '# VLAN attachment riding your existing Dedicated Interconnect.',
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
        '}'
      ].join('\n'));

      B.push([
        '# Allow your on-prem ranges to reach the system over the interconnect.',
        'resource "google_compute_firewall" "allow_onprem" {',
        '  count         = length(var.onprem_cidrs) > 0 ? 1 : 0',
        '  name          = "${local.name}-allow-onprem"',
        '  network       = ' + netName(s),
        '  direction     = "INGRESS"',
        '  source_ranges = var.onprem_cidrs',
        '  allow {',
        '    protocol = "tcp"',
        '    ports    = ["80", "443", "8080"]',
        '  }',
        DEP,
        '}'
      ].join('\n'));

      B.push([
        '# Resolve on-prem hostnames inside the VPC by forwarding the on-prem domain to your resolvers.',
        'resource "google_dns_managed_zone" "onprem_forward" {',
        '  count       = var.onprem_dns_domain != "" && length(var.onprem_dns_servers) > 0 ? 1 : 0',
        '  name        = "${local.name}-onprem"',
        '  dns_name    = var.onprem_dns_domain',
        '  description = "Forward on-prem domain resolution across the interconnect."',
        '  visibility  = "private"',
        '  private_visibility_config {',
        '    networks {',
        '      network_url = ' + netRef(s),
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

    if (s.enforceVpcSc) {
      B.push([
        '# VPC Service Controls perimeter. Needs an Access Context Manager access policy at the',
        '# org or folder level. Set access_policy_id in terraform.tfvars before apply.',
        'resource "google_access_context_manager_service_perimeter" "perimeter" {',
        '  count  = var.access_policy_id == "" ? 0 : 1',
        '  parent = "accessPolicies/${var.access_policy_id}"',
        '  name   = "accessPolicies/${var.access_policy_id}/servicePerimeters/${replace(local.name, "-", "_")}"',
        '  title  = "${local.name}-perimeter"',
        '  status {',
        '    resources = ["projects/${data.google_project.this.number}"]',
        '    restricted_services = [',
        '      "aiplatform.googleapis.com",',
        '      "discoveryengine.googleapis.com",',
        '      "storage.googleapis.com",',
        '      "bigquery.googleapis.com"',
        '    ]',
        '  }',
        '}'
      ].join('\n'));
    }

    return B.join('\n\n') + '\n';
  }

  function outputsTf(s) {
    var outs = [
      ['data_bucket', 'google_storage_bucket.data.name', 'Bucket holding the agent archive and the seed-docs prefix.'],
      ['seed_docs_uri', '"gs://${google_storage_bucket.data.name}/seed-docs/"', 'Upload your source documents here, then index them.']
    ];
    if (s.runtime === 'agentengine') {
      outs.push(['agent_url', 'google_cloud_run_v2_service.api.uri', 'Cloud Run URL of the agent service.']);
      outs.push(['api_gateway_host', 'google_api_gateway_gateway.gw.default_hostname', 'Public hostname of the API gateway.']);
      outs.push(['agent_engine', 'google_vertex_ai_reasoning_engine.agent.name', 'Agent Engine resource name.']);
    } else {
      outs.push(['agent_cluster', 'google_container_cluster.agent.name', 'GKE cluster hosting the agent.']);
      outs.push(['agent_endpoint', 'try(kubernetes_service_v1.agent.status[0].load_balancer[0].ingress[0].ip, "pending")', 'LoadBalancer IP of the agent service (after the second apply phase).']);
    }
    if (createVpc(s)) outs.push(['network', 'google_compute_network.vpc.name', 'Dedicated VPC network.']);
    if (s.hybrid) outs.push(['onprem_vlan_attachment', 'try(google_compute_interconnect_attachment.onprem[0].name, "not configured - set onprem_interconnect")', 'VLAN attachment bridging to your on-prem interconnect.']);
    if (s.managedSearch && s.hasUnstructured) outs.push(['docs_data_store', 'google_discovery_engine_data_store.docs.data_store_id', 'Unstructured docs data store id.']);
    if (s.managedSearch && s.hasWebsite) outs.push(['site_data_store', 'google_discovery_engine_data_store.site.data_store_id', 'Owned site data store id.']);
    var blocks = outs.map(function (o) {
      return ['output "' + o[0] + '" {', '  description = ' + q(o[2]), '  value       = ' + o[1], '}'].join('\n');
    });
    return blocks.join('\n\n') + '\n';
  }

  function readme(s) {
    var L = [];
    L.push('# ' + s.prefix + '-' + s.env + ' deployment');
    L.push('');
    L.push('Terraform for an agentic GenAI system on Google Cloud, generated from the agentic system');
    L.push('designer. The agent is generic: it runs a generate step then a validate step, both driven');
    L.push('by instructions you pass in. The task wording and the grounding source are configuration,');
    L.push('not code.');
    L.push('');
    L.push('## What this provisions');
    L.push('');
    if (s.runtime === 'gke') L.push('- The agent on GKE Autopilot (Deployment + LoadBalancer Service); the LoadBalancer is the entry.');
    else L.push('- The agent on Cloud Run behind an API gateway, plus a Vertex AI Agent Engine target.');
    if (s.managedSearch) L.push('- Vertex AI Search data store(s) and a search engine per store for grounding.');
    if (s.selfHostSearch) L.push('- Self-hosted Elasticsearch in the cluster for vector search (reached at http://elasticsearch:9200).');
    L.push('- Cloud Storage bucket with a seed-docs/ prefix for your documents and the agent archive.');
    if (s.modelArmor) L.push('- Model Armor template for prompt-injection and content filtering.');
    if (usesAlloy(s)) L.push('- AlloyDB for agent state on ' + (createVpc(s) ? 'a dedicated VPC' : 'the default network') + ' with Private Service Access.');
    if (createVpc(s)) L.push('- A dedicated VPC network for GKE, AlloyDB, and Redis (toggle Dedicated VPC off to use the default network).');
    if (usesSpanner(s)) L.push('- Spanner for agent state.');
    if (usesCloudSql(s)) L.push('- Cloud SQL (PostgreSQL) for agent state.');
    if (s.managedRedis) L.push('- Memorystore on the VPC for the response cache.');
    if (s.selfHostCache) L.push('- Self-hosted Redis in the cluster for the response cache (reached at redis://redis:6379).');
    L.push('- BigQuery dataset for feedback and evaluation.');
    if (s.isAutomation) L.push('- Pub/Sub trigger topic with a dead-letter queue and the service-agent IAM it needs.');
    if (s.selfHost) L.push('- A separate GKE cluster with a GPU node pool for the self-hosted model (vLLM).');
    if (s.cmek) L.push('- Customer-managed encryption keys (CMEK) via Cloud KMS, applied to every managed store: Cloud Storage, the state store (AlloyDB / Spanner / Cloud SQL / Memorystore), the Memorystore cache, and the BigQuery feedback dataset. Self-hosted stores (a self-built vector store or Redis on GKE) and Vertex AI Search are not covered here.');
    if (s.enforceVpcSc) L.push('- A VPC Service Controls perimeter (needs an org access policy).');
    L.push('');
    L.push('## Apply');
    L.push('');
    L.push('```');
    L.push('terraform fmt   # canonicalize formatting');
    L.push('terraform init');
    if (s.gke) {
      L.push('# GKE runtime: two-phase apply, because the kubernetes provider needs the cluster first.');
      L.push('terraform apply -target=google_container_cluster.agent');
      L.push('terraform apply');
    } else {
      L.push('terraform plan');
      L.push('terraform apply');
    }
    L.push('```');
    L.push('');
    L.push('If a resource fails with an API-not-enabled error on the very first apply, wait a minute and');
    L.push('re-run apply; API enablement can take a moment to propagate.');
    L.push('');
    if (s.enforceVpcSc) {
      L.push('The VPC-SC perimeter is created only when `access_policy_id` is set in `terraform.tfvars`.');
      L.push('It needs an Access Context Manager access policy at the org or folder level. Left empty, the');
      L.push('bundle applies without the perimeter (sandbox-friendly); set it for production VPC-SC.');
      L.push('');
    }
    if (s.cmek) {
      L.push('CMEK is on. The KMS key ring, key, and a service-agent key binding for each managed store');
      L.push('(Cloud Storage, the state store, the Memorystore cache, and BigQuery) are created here. Run');
      L.push('terraform plan first: the service agents are provisioned via google_project_service_identity,');
      L.push('and on a brand-new project the first apply can need a re-run while the agents propagate. To');
      L.push('deploy with Google-managed keys instead, set CMEK to Google-managed in the designer.');
      L.push('');
    }
    L.push('## Build and deploy the agent container');
    L.push('');
    L.push('The services start from a placeholder image. Build the agent in `agent/`, push it to Artifact');
    L.push('Registry, and set `gateway_image` in `terraform.tfvars`:');
    L.push('');
    L.push('```');
    L.push('gcloud builds submit agent/ --tag REGION-docker.pkg.dev/PROJECT/REPO/agent:latest');
    L.push('```');
    L.push('');
    if (s.runtime === 'agentengine') {
      L.push('To run on the managed Agent Engine instead of Cloud Run, push the agent object with the ADK');
      L.push('CLI (Agent Engine packages the code at build time, which Terraform cannot do):');
      L.push('');
      L.push('```');
      L.push('adk deploy agent_engine --agent agent/');
      L.push('```');
      L.push('');
    }
    L.push('## After apply: load your documents');
    L.push('');
    L.push('1. Upload source documents to the seed-docs prefix:');
    L.push('');
    L.push('```');
    L.push('gsutil -m cp -r ./my-docs/* "$(terraform output -raw seed_docs_uri)"');
    L.push('```');
    L.push('');
    if (s.selfHostSearch) {
      L.push('2. Index the documents into Elasticsearch (in-cluster, at http://elasticsearch:9200, index');
      L.push('   `docs`). Run your embedding/ingestion job from a pod in the cluster, or port-forward the');
      L.push('   service and load with the Elasticsearch bulk API. The agent reads from this index.');
    } else if (s.managedSearch) {
      L.push('2. Import them into the Vertex AI Search data store from the console or the API. The owned');
      L.push('   site is crawled from `' + s.siteUrl + '` (pattern `' + uriPattern(s.siteUrl) + '`). Verify');
      L.push('   site ownership in the console before the crawl can index it.');
    } else {
      L.push('2. Wire your own grounding source; this design has no managed search index.');
    }
    L.push('');
    if (s.hybrid) {
      L.push('## Hybrid: connecting to your existing Cloud Interconnect');
      L.push('');
      L.push('This bundle emits the cloud-side bridge to your on-premise network: a Cloud Router, a VLAN');
      L.push('attachment on your existing Dedicated Interconnect, an ingress firewall rule, and a private');
      L.push('DNS forwarding zone. Every piece is gated on a variable, so an unset apply is a no-op for the');
      L.push('bridge. To turn it on, set in `terraform.tfvars`:');
      L.push('');
      L.push('- `onprem_interconnect` - self-link of your existing Cloud Interconnect (creates the Cloud');
      L.push('  Router and the VLAN attachment). Partner Interconnect uses a pairing key instead; adjust');
      L.push('  the attachment block if so.');
      L.push('- `onprem_cidrs` - on-prem IP ranges allowed to reach the system (creates the firewall rule).');
      L.push('- `cloud_router_asn` - the BGP ASN for the Cloud Router (default 64514).');
      L.push('- `onprem_dns_domain` + `onprem_dns_servers` - to forward on-prem name resolution into the VPC.');
      L.push('');
      L.push('After the attachment is up, add a `google_compute_router_peer` using the IPs the attachment');
      L.push('allocates (`cloud_router_ip_address` / `customer_router_ip_address`) and your on-prem ASN to');
      L.push('bring up the BGP session.');
      L.push('');
      if (s.runtime === 'agentengine') {
        L.push('IMPORTANT - Cloud Run runtime: this design runs the agent on Agent Engine (Cloud Run), which');
        L.push('is NOT in the VPC, so the interconnect alone does not connect it to on-premise. Before the');
        L.push('agent can reach on-prem systems (or be reached from on-prem) over the link you must add a');
        L.push('Serverless VPC Access connector in the VPC and a `vpc_access` block on the Cloud Run service');
        L.push('(egress), plus an internal Application Load Balancer or Private Service Connect for on-prem');
        L.push('to reach the agent (ingress). The firewall and router below govern VPC-resident targets.');
        L.push('Switching the Agent Runtime to GKE puts the agent in the VPC and avoids this extra wiring.');
        L.push('');
      }
    }
    L.push('## On-prem data integration');
    L.push('');
    L.push('This Terraform does not provision your on-prem database. To wire an on-prem source into this');
    L.push('system' + (s.hybrid ? ' over the interconnect bridge above' : '') + ':');
    L.push('');
    if (!s.hybrid) {
      L.push('- Connectivity: set up Cloud VPN (HA VPN) or Cloud Interconnect between your VPC and the');
      L.push('  on-prem network. Add a Serverless VPC Access connector so Cloud Run can reach private IPs.');
      L.push('  (Select the Hybrid deployment in the designer to have the interconnect bridge emitted.)');
    }
    L.push('- Firewall and routes: allow the agent egress range to the database host and port only.');
    L.push('- DNS: use Cloud DNS private zones or peering so the on-prem hostname resolves inside the VPC.');
    L.push('- Credentials: store the database user and password in Secret Manager' + (s.hasOnprem ? ' (the `onprem-db` secret is created for this)' : '') + ' and grant the agent service account access.');
    L.push('- Least privilege: a read-only database account scoped to the needed tables.');
    L.push('');
    L.push('## Notes');
    L.push('');
    L.push('- Model ids are mapped to deployable Vertex ids; update `generation_model` and');
    L.push('  `validation_model` to the latest available in your region if needed.');
    L.push('- Model Armor and Agent Engine are newer APIs; if a resource is not yet available in your');
    L.push('  provider version, deploy that piece from the console or the SDK and remove its block.');
    return L.join('\n') + '\n';
  }

  function agentPy() {
    return [
      '"""Generic grounded generate-and-validate agent.',
      '',
      'The task wording, the grounding source, and the model ids are read from the environment, set by',
      'Terraform from the deployment config. This file makes no assumption about the topic domain or the',
      'site being indexed. Grounding uses Vertex AI Search when GROUNDING_DATASTORE_ID is set, or a',
      'self-hosted Elasticsearch index when ELASTICSEARCH_URL is set.',
      '"""',
      'import json',
      'import os',
      'import urllib.request',
      '',
      'import vertexai',
      'from vertexai.generative_models import GenerativeModel, Tool, grounding',
      '',
      'PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT", "")',
      'REGION = os.environ.get("GOOGLE_CLOUD_REGION", "us-central1")',
      'DATASTORE_ID = os.environ.get("GROUNDING_DATASTORE_ID", "")',
      'ES_URL = os.environ.get("ELASTICSEARCH_URL", "")',
      'ES_INDEX = os.environ.get("ELASTICSEARCH_INDEX", "docs")',
      'GENERATION_INSTRUCTION = os.environ.get("GENERATION_INSTRUCTION", "")',
      'VALIDATION_INSTRUCTION = os.environ.get("VALIDATION_INSTRUCTION", "")',
      'GENERATION_MODEL = os.environ.get("GENERATION_MODEL", "gemini-2.5-flash")',
      'VALIDATION_MODEL = os.environ.get("VALIDATION_MODEL", GENERATION_MODEL)',
      '',
      'if PROJECT:',
      '    vertexai.init(project=PROJECT, location=REGION)',
      '',
      '',
      'def _grounding_tools():',
      '    if not DATASTORE_ID:',
      '        return []',
      '    ds = (',
      '        f"projects/{PROJECT}/locations/global/collections/"',
      '        f"default_collection/dataStores/{DATASTORE_ID}"',
      '    )',
      '    retrieval = grounding.Retrieval(grounding.VertexAISearch(datastore=ds))',
      '    return [Tool.from_retrieval(retrieval)]',
      '',
      '',
      'def _es_context(topic: str, k: int = 5) -> str:',
      '    """Keyword search against the self-hosted Elasticsearch index, if configured."""',
      '    if not ES_URL:',
      '        return ""',
      '    body = json.dumps({"size": k, "query": {"match": {"text": topic}}}).encode("utf-8")',
      '    req = urllib.request.Request(',
      '        f"{ES_URL}/{ES_INDEX}/_search",',
      '        data=body,',
      '        headers={"Content-Type": "application/json"},',
      '    )',
      '    try:',
      '        with urllib.request.urlopen(req, timeout=5) as resp:',
      '            hits = json.load(resp).get("hits", {}).get("hits", [])',
      '    except Exception:',
      '        return ""',
      '    return "\\n\\n".join(h.get("_source", {}).get("text", "") for h in hits)',
      '',
      '',
      'def generate(topic: str) -> str:',
      '    context = _es_context(topic)',
      '    model = GenerativeModel(',
      '        GENERATION_MODEL,',
      '        system_instruction=GENERATION_INSTRUCTION,',
      '        tools=_grounding_tools(),',
      '    )',
      '    prompt = f"Context:\\n{context}\\n\\nTopic: {topic}" if context else f"Topic: {topic}"',
      '    resp = model.generate_content(prompt)',
      '    return resp.text',
      '',
      '',
      'def validate(topic: str, draft: str) -> dict:',
      '    model = GenerativeModel(VALIDATION_MODEL, system_instruction=VALIDATION_INSTRUCTION)',
      '    prompt = (',
      '        f"Topic: {topic}\\n\\nText to review:\\n{draft}\\n\\n"',
      '        "Reply APPROVE or REVISE with a short reason."',
      '    )',
      '    resp = model.generate_content(prompt)',
      '    verdict = resp.text.strip()',
      '    return {"approved": verdict.upper().startswith("APPROVE"), "review": verdict}',
      '',
      '',
      'def revise(topic: str, draft: str, review: dict) -> str:',
      '    """The Generator revises its own draft from the Validator critique (the Self-Refine loop)."""',
      '    model = GenerativeModel(',
      '        GENERATION_MODEL,',
      '        system_instruction=GENERATION_INSTRUCTION,',
      '        tools=_grounding_tools(),',
      '    )',
      '    context = _es_context(topic)',
      '    prefix = f"Context:\\n{context}\\n\\n" if context else ""',
      '    prompt = (',
      '        f"{prefix}Topic: {topic}\\n\\nYour previous draft:\\n{draft}\\n\\n"',
      '        f"Reviewer feedback:\\n{review[\'review\']}\\n\\nRevise the draft to address the feedback."',
      '    )',
      '    return model.generate_content(prompt).text',
      '',
      '',
      'def run(topic: str, max_revisions: int = 2) -> dict:',
      '    draft = generate(topic)',
      '    review = validate(topic, draft)',
      '    revisions = 0',
      '    while not review["approved"] and revisions < max_revisions:',
      '        draft = revise(topic, draft, review)',
      '        review = validate(topic, draft)',
      '        revisions += 1',
      '    return {"topic": topic, "output": draft, "validation": review, "revisions": revisions}',
      '',
      '',
      'if __name__ == "__main__":',
      '    import sys',
      '    arg = sys.argv[1] if len(sys.argv) > 1 else "example topic"',
      '    print(json.dumps(run(arg), indent=2))',
      ''
    ].join('\n');
  }

  function requirementsTxt() {
    return ['google-cloud-aiplatform>=1.71.0', 'vertexai>=1.71.0', ''].join('\n');
  }

  function dockerfile() {
    return [
      'FROM python:3.11-slim',
      'WORKDIR /app',
      'COPY requirements.txt .',
      'RUN pip install --no-cache-dir -r requirements.txt',
      'COPY . .',
      'ENV PORT=8080',
      'CMD ["python", "agent.py"]',
      ''
    ].join('\n');
  }

  function generate(spec) {
    var s = norm(spec);
    var files = {};
    files['versions.tf'] = versionsTf(s);
    files['variables.tf'] = variablesTf(s);
    files['terraform.tfvars'] = tfvars(s);
    files['main.tf'] = mainTf(s);
    files['outputs.tf'] = outputsTf(s);
    files['README.md'] = readme(s);
    files['agent/agent.py'] = agentPy(s);
    files['agent/requirements.txt'] = requirementsTxt(s);
    files['agent/Dockerfile'] = dockerfile();
    return { files: files, spec: s };
  }

  function crc32(bytes) {
    var crc = -1;
    for (var i = 0; i < bytes.length; i++) {
      var c = (crc ^ bytes[i]) & 0xff;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (c >>> 1) ^ 0xEDB88320 : c >>> 1;
      crc = (crc >>> 8) ^ c;
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
    central.forEach(function (c) { chunks.push(c.head, c.name); cdSize += c.head.length + c.name.length; });
    var eocd = [].concat(
      u32(0x06054b50), u16(0), u16(0), u16(names.length), u16(names.length),
      u32(cdSize), u32(cdStart), u16(0)
    );
    chunks.push(Uint8Array.from(eocd));
    var total = 0; chunks.forEach(function (c) { total += c.length; });
    var out = new Uint8Array(total), p = 0;
    chunks.forEach(function (c) { out.set(c, p); p += c.length; });
    return out;
  }

  var api = { generate: generate, zip: zip, MODEL_MAP: MODEL_MAP };
  if (typeof window !== 'undefined') window.TfGen = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
