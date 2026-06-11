/* Test harness for system-design/sys-tfgen.js: generate Terraform for every
   preset plus variants the presets do not reach, assert the v2 invariants,
   write bundles to /tmp/sys-tfgen-presets for inspection. Throwaway, not shipped. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;
const SD = path.join(ROOT, 'system-design');
const sandbox = { globalThis: null, window: undefined, console, TextEncoder };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
['sys-catalog.js', 'sys-presets.js', 'sys-derive.js', 'sys-tfgen.js'].forEach(f =>
  vm.runInContext(fs.readFileSync(path.join(SD, f), 'utf8'), sandbox, { filename: f }));
const ASD2 = sandbox.ASD2;

const OUT = '/tmp/sys-tfgen-presets';
fs.rmSync(OUT, { recursive: true, force: true });

/* test matrix: all presets all-Auto, plus targeted variants */
const cases = [];
for (const purpose of Object.keys(ASD2.presets.PRESETS))
  for (const key of Object.keys(ASD2.presets.PRESETS[purpose]))
    cases.push({ name: `${purpose}__${key}`, purpose, inputs: JSON.parse(JSON.stringify(ASD2.presets.PRESETS[purpose][key].inputs)), overrides: {} });
const base = () => JSON.parse(JSON.stringify(ASD2.presets.PRESETS.assistant.expert_copilot.inputs));
cases.push({ name: 'variant__hybrid', purpose: 'assistant', inputs: Object.assign(base(), { deployment: 'hybrid' }), overrides: {} });
cases.push({ name: 'variant__selfhost', purpose: 'assistant', inputs: Object.assign(base(), { modelStrategy: 'self_host' }), overrides: {} });
cases.push({ name: 'variant__vertex_vec', purpose: 'assistant', inputs: Object.assign(base(), { opsModel: 'self_managed' }), overrides: { vectorDB: 'vertex' } });
cases.push({ name: 'variant__multiregion', purpose: 'assistant', inputs: base(), overrides: { multiRegion: true } });
cases.push({ name: 'variant__claude', purpose: 'assistant', inputs: base(), overrides: { reasoningModel: 'claude-opus-48' } });
cases.push({ name: 'variant__hybrid_gke', purpose: 'assistant', inputs: Object.assign(base(), { deployment: 'hybrid', opsModel: 'self_managed' }), overrides: {} });

let failures = 0;
const fail = (name, msg) => { failures++; console.log(`  FAIL [${name}] ${msg}`); };

for (const tc of cases) {
  const { arch } = ASD2.derive(tc.purpose, tc.inputs, tc.overrides);
  const { files, placeholders, steps, ctx } = ASD2.tfgen.generate(arch, tc.inputs);
  const dir = path.join(OUT, tc.name);
  for (const [name, content] of Object.entries(files)) {
    const fp = path.join(dir, name);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content);
  }
  const all = Object.values(files).join('\n');
  const mt = files['main.tf'];
  const stepIds = steps.map(s => s.id);
  const phVars = placeholders.map(p => p.var);
  const has = (re, s) => re.test(s === undefined ? mt : s);

  console.log(`${tc.name}: runtime=${arch.agent.runtime} hybrid=${ctx.hybrid} vais=${ctx.vais} selfbuilt=${ctx.selfbuilt} vec=${arch.retrieval.vectorDB} state=${arch.state.store} cmek=${ctx.cmek}`);

  /* v2 invariants */
  if (/elastic/i.test(all)) fail(tc.name, 'Elasticsearch leaked into the bundle');
  if (/em-dash|—/.test(all)) fail(tc.name, 'non-ASCII dash in output');
  if (ctx.hybrid && has(/google_api_gateway/)) fail(tc.name, 'hybrid must not emit a public API gateway');
  if (ctx.hybrid && !has(/google_compute_interconnect_attachment/)) fail(tc.name, 'hybrid missing the interconnect bridge');
  if (ctx.hybrid && ctx.runtime === 'agentengine' && !has(/INGRESS_TRAFFIC_INTERNAL_ONLY/)) fail(tc.name, 'hybrid Cloud Run must be internal-only');
  if (ctx.hybrid && ctx.gke && !has(/load-balancer-type" = "Internal"/)) fail(tc.name, 'hybrid GKE LB must be internal');
  if (!ctx.hybrid && ctx.publicGateway && !has(/google_api_gateway_gateway/)) fail(tc.name, 'public gateway expected but not emitted');
  if (has(/google_secret_manager_secret/) !== ctx.secretManagerOn) fail(tc.name, 'Secret Manager emission must match secretManagerOn');
  if (has(/google_kms_crypto_key/) !== ctx.cmek) fail(tc.name, 'KMS emission must match cmek');
  if (ctx.cmek && ctx.alloyAny && !has(/google_kms_crypto_key_iam_member" "alloydb/)) fail(tc.name, 'CMEK on but no AlloyDB key binding');
  if (ctx.cmek && ctx.redisManaged && !has(/google_kms_crypto_key_iam_member" "redis/)) fail(tc.name, 'CMEK on but no Redis key binding');
  if (ctx.vais && ctx.docCorpus && !has(/google_discovery_engine_data_store" "docs/)) fail(tc.name, 'vais+corpus missing docs data store');
  if (ctx.vais && ctx.website && !has(/google_discovery_engine_target_site/)) fail(tc.name, 'vais+website missing crawl target');
  if (ctx.vectorVertex && !has(/google_vertex_ai_index"/)) fail(tc.name, 'vertex vector store missing index');
  if (ctx.vectorAlloy && !has(/google_alloydb_cluster/)) fail(tc.name, 'alloydb vector store missing cluster');
  if (has(/google_redis_cluster/) !== ctx.redisManaged) fail(tc.name, 'Memorystore emission must match redisManaged');
  if (has(/kubernetes_deployment_v1" "redis/) !== ctx.redisOnGke) fail(tc.name, 'in-cluster Redis emission must match redisOnGke');
  if (has(/google_pubsub_topic/) !== ctx.automation) fail(tc.name, 'Pub/Sub emission must match automation purpose');
  if (ctx.vpcsc !== has(/google_access_context_manager_service_perimeter/)) fail(tc.name, 'VPC-SC emission must match enforceVpcSc');
  if (ctx.vpc !== has(/google_compute_network" "vpc/)) fail(tc.name, 'dedicated VPC emission must match vpcDrawn');
  if (ctx.selfHost !== has(/google_container_node_pool" "gpu/)) fail(tc.name, 'GPU pool emission must match selfHostAny');

  /* steps conditional correctness */
  const expectStep = (id, cond) => { if (stepIds.includes(id) !== cond) fail(tc.name, `step ${id} expected=${cond}`); };
  expectStep('adk-deploy', ctx.runtime === 'agentengine');
  expectStep('two-phase-apply', ctx.gke);
  expectStep('claude-terms', ctx.claude);
  expectStep('scann-extension', ctx.vectorAlloy);
  expectStep('vector-backfill', ctx.vectorVertex);
  expectStep('site-verify', ctx.vais && ctx.website);
  expectStep('bgp-peer', ctx.hybrid);
  expectStep('vllm-deploy', ctx.selfHost);
  if (phVars.includes('vllm_endpoint') !== ctx.selfHost) fail(tc.name, 'vllm_endpoint placeholder must match selfHost');
  expectStep('redis-auth', ctx.secretManagerOn);
  expectStep('note-model-map', true);

  /* placeholders */
  if (!phVars.includes('project_id')) fail(tc.name, 'project_id placeholder missing');
  const regionBlock = files['variables.tf'].match(/variable "region" \{[\s\S]*?\n\}/)[0];
  if (/\n {2}default\s+=/.test(regionBlock) === !!arch.gov.residencyPin) fail(tc.name, 'region default must be absent exactly when residency is pinned');
  if (phVars.includes('access_policy_id') !== ctx.vpcsc) fail(tc.name, 'access_policy_id placeholder must match vpcsc');
  if (phVars.includes('onprem_interconnect') !== ctx.hybrid) fail(tc.name, 'onprem placeholders must match hybrid');
  if (phVars.includes('site_url') !== ctx.website) fail(tc.name, 'site_url placeholder must match website source');

  /* every variable referenced in main/outputs is declared; every declared is used */
  const declared = new Set([...files['variables.tf'].matchAll(/variable "([^"]+)"/g)].map(m => m[1]));
  const used = new Set([...(mt + files['outputs.tf'] + files['versions.tf']).matchAll(/var\.([a-z0-9_]+)/g)].map(m => m[1]));
  for (const u of used) if (!declared.has(u)) fail(tc.name, `var.${u} used but not declared`);
  for (const d of declared) if (!used.has(d)) fail(tc.name, `variable ${d} declared but never used`);

  /* README contains every step title and required placeholder */
  for (const s of steps) if (!files['README.md'].includes(s.title)) fail(tc.name, `README missing step: ${s.title}`);
  for (const p of placeholders) if (!files['README.md'].includes('`' + p.var + '`')) fail(tc.name, `README missing placeholder: ${p.var}`);

  /* zip round-trips (constructor-name check: vm sandbox is a different realm,
     so instanceof against the host Uint8Array is always false) */
  const z = ASD2.tfgen.zip(files);
  const zipOk = z && z.constructor && z.constructor.name === 'Uint8Array' && z.length > 1000
    && z[0] === 0x50 && z[1] === 0x4b; /* PK local-file-header magic */
  if (!zipOk) fail(tc.name, 'zip output looks wrong');
}

console.log(failures ? `\n${failures} FAILURES` : '\nAll assertions passed for ' + cases.length + ' cases.');
process.exitCode = failures ? 1 : 0;
