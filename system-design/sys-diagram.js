/* Agentic System Designer v2 - mermaid diagram builder.
   buildDiagram(arch, {dir, theme}) is pure: it reads only the derived arch model
   (no inputs, no DOM, no state), so the diagram can never disagree with the BoM
   or cost panels about an architecture decision. Composed from small leg
   functions; node ids match the original (agentic-system-designer.html
   buildMainDiagram, lines 2168-2479) so tooltips and palette classes carry over.
   Boundary conventions enforced structurally:
   - The dedicated VPC box holds self-hosted compute only (GKE agent, vLLM fleet,
     Redis on GKE, the assistant retrieval funnel, the hybrid Cloud Router).
   - Managed stores (vector store, state, durable tier, Memorystore cache) are
     drawn outside the VPC with the PSC mechanism tagged on the edge.
   - CMEK / Data Access audit edges reach exactly arch.security.kmsTargets.
   - Hybrid is private-only ingress: no Client / Trigger / API Gateway boxes; the
     on-prem network enters through the in-VPC Cloud Router + an IAP / mTLS hop. */
(function (NS) {
  'use strict';
  const C = () => NS.catalog;

  function buildDiagram(arch, opts) {
    const a = arch;
    const dir = (opts && opts.dir) || 'LR';
    const theme = (opts && opts.theme) || 'dark';
    const auto = a.purpose === 'automation';
    const L = [], cls = [];
    const clean = s => String(s).replace(/"/g, '').replace(/\n/g, '<br/>');
    const node = (id, label, tier, shape) => {
      cls.push(`class ${id} ${tier}`);
      const lab = clean(label);
      return shape === 'cyl' ? `${id}[("${lab}")]` : `${id}["${lab}"]`;
    };
    L.push('flowchart ' + dir);

    const privateOnly = a.topology.privateOnly;
    const cacheOn = a.caching.responseCacheOn;
    const cacheLabel = `Response cache<br/>${[a.caching.exactCache && 'exact', a.caching.semanticCache && 'semantic'].filter(Boolean).join(' + ')}`;
    const showFunnel = a.retrieval.retrInVpc;
    const ingressId = auto ? 'Trig' : 'Client';
    const ingressLabel = auto ? 'Trigger (ticket/event)' : 'Client UI';
    const aeLabel = `Agent compute (${a.agent.gke ? 'GKE Autopilot' : 'Agent Runtime'})`;
    const storeLabel = a.retrieval.ragEngine === 'vais' ? 'Agent Search'
      : a.retrieval.vectorDB === 'vertex' ? 'Vector Search (ScaNN)' : 'AlloyDB vector (ScaNN)';

    /* Agent compute box: single = Generator only; multi = an Orchestrator-routed
       team (hub-and-spoke). The Retrieval agent owns the data tools, the
       Generator drafts, the Validator critiques, and every hand-off returns to
       the Orchestrator, which enforces the loop cap and keeps run state in the
       state store consistent. No agent talks point-to-point to another. Each
       dispatch is one solid arrow with the sync response implied, like every
       other sync call in the diagram - the Validator's pass-or-revise verdict
       included, so no revise edge is drawn; the loop lives in the tooltips,
       the reactMaxIter decision, and the latency trace's ReAct loop item. */
    const agentBox = () => {
      L.push(`subgraph AE["${aeLabel}"]`);
      if (a.agent.multiAgent) {
        ['Orchestrator', 'Generator', 'Validator'].forEach(id => L.push(node(id, id, 'orch')));
        if (a.agent.retrieverDrawn) {
          L.push(node('Retriever', 'Retrieval agent', 'retr'));
          L.push('Orchestrator --> Retriever');
        }
        L.push('Orchestrator --> Generator');
        L.push('Orchestrator --> Validator');
      } else {
        L.push(node('Generator', 'Generator', 'orch'));
      }
      L.push('end');
    };

    /* ---- ingress (public door; suppressed in private-only hybrid) ---- */
    let head = ingressId;
    if (!privateOnly) {
      L.push(node(ingressId, ingressLabel, 'client'));
      if (a.models.inboundChips.length) {
        L.push(node('EdgeGW', `API Gateway<br/>${a.models.inboundChips.join(' · ')}`, 'gateway'));
        L.push(`${head} --> EdgeGW`);
        head = 'EdgeGW';
      }
    }

    /* ---- VPC-SC perimeter wraps the Google services ---- */
    if (a.topology.perimeterOn) L.push('subgraph PERIM["VPC-SC perimeter"]');

    /* ---- dedicated VPC: self-hosted compute only ---- */
    if (a.topology.vpcDrawn) {
      L.push('subgraph VPC["Dedicated VPC network"]');
      if (a.caching.cacheInVpc) L.push(node('Cache', cacheLabel, 'data', 'cyl'));
      if (a.agent.gke) agentBox();
      if (showFunnel) L.push(node('Retr', 'Retrieval funnel', 'retr'));
      if (a.state.stateInVpc) L.push(node('State', a.state.stateLabel, 'data', 'cyl'));
      if (a.models.selfHostAny) L.push(node('LLM', 'Model(s)<br/>vLLM on GKE', 'orch'));
      if (a.topology.hybridLink) L.push(node('CloudRouter', 'Cloud Router<br/>+ VLAN attachment', 'gateway'));
      L.push('end');
    } else if (showFunnel) {
      /* Funnel with the VPC box pinned off: still self-built compute, just unboxed. */
      L.push(node('Retr', 'Retrieval funnel', 'retr'));
    }

    /* ---- managed residents (perimeter, outside the VPC) ---- */
    if (!a.agent.gke) agentBox();
    if (cacheOn && !a.caching.cacheInVpc) L.push(node('Cache', cacheLabel, 'data', 'cyl'));
    if (cacheOn && !privateOnly) { L.push(`${head} --> Cache`); L.push(`Cache -- hit --> ${head}`); }
    if (showFunnel) L.push(`${a.agent.dataAgent} --> Retr`);
    if (a.gov.sandbox) { L.push(node('Sand', 'Transient sandbox', 'gov')); L.push(`${a.agent.execAgent} --> Sand`); }

    /* ---- model leg: Model Armor inline when derived on ---- */
    if (!a.models.selfHostAny) L.push(node('LLM', 'Model(s)', 'orch'));
    if (a.models.armorOn) {
      L.push(node('Armor', 'Model Armor<br/>injection, redaction', 'gateway'));
      L.push('AE --> Armor');
      L.push('Armor --> LLM');
    } else {
      L.push('AE --> LLM');
    }

    /* ---- data plane: offline index + live sources + web grounding ---- */
    const cat = C();
    if (a.retrieval.storeDrawn) {
      L.push(node('Store', storeLabel, 'data', 'cyl'));
      const storeReader = showFunnel ? 'Retr' : a.agent.dataAgent;
      L.push(a.retrieval.selfbuilt ? `${storeReader} -- PSC --> Store` : `${storeReader} --> Store`);
      L.push(node('GCS', 'Cloud Storage<br/>docs + artifacts', 'data', 'cyl'));
      L.push(node('Idx', `Index sources<br/>${a.retrieval.idxSel.map(s => cat.INDEXED_LABEL[s]).join(' / ')}`, 'data'));
      L.push('GCS -. source docs .-> Idx');
      if (a.retrieval.ragEngine === 'vais') {
        L.push('Idx -. crawl + parse + embed .-> Store');
      } else {
        L.push(node('DocAI', 'Document AI', 'data'));
        L.push(node('Emb', 'Chunk + embed', 'data'));
        L.push('Idx -.-> DocAI');
        L.push('DocAI -.-> Emb');
        L.push('Emb -. write · PSC .-> Store');
      }
    }
    if (a.retrieval.liveSel.length) {
      L.push(node('Live', `Live data<br/>${a.retrieval.liveSel.map(s => cat.SRC_LABEL[s]).join(' · ')}`, 'data'));
      L.push(`${a.agent.dataAgent} --> Live`);
    }
    if (a.retrieval.hasWebGrounding) {
      L.push(node('WebG', 'Web grounding<br/>Google Search', 'data'));
      L.push(`${a.agent.dataAgent} --> WebG`);
    }

    /* ---- secrets: only a self-hosted Redis-on-GKE tier stores one ---- */
    if (a.security.secretManagerOn) {
      L.push(node('SecretMgr', 'Secret Manager', 'gov'));
      L.push('AE -. Redis AUTH .-> SecretMgr');
    }

    /* ---- state: hot tier (in-VPC Redis or managed over PSC) + durable tier ---- */
    if (!a.state.stateInVpc) L.push(node('State', a.state.stateLabel, 'data', 'cyl'));
    L.push(`AE -- state${a.state.stateConn ? ` · ${a.state.stateConn}` : ''} --> State`);
    if (a.state.durTier) {
      L.push(node('StateDur', a.state.durTier.label, 'data', 'cyl'));
      L.push(`State -. durable · ${a.state.durTier.conn} .-> StateDur`);
    }

    /* ---- CMEK and Data Access audit, over the managed stores only ---- */
    if (a.security.cmek && a.security.kmsTargets.length) {
      L.push(node('KMS', 'Cloud KMS (CMEK)', 'gov'));
      a.security.kmsTargets.forEach(t => L.push(`KMS -. encrypts .-> ${t}`));
    }
    if (a.security.dataAccessAudit && a.security.auditTargets.length) {
      L.push(node('Audit', 'Cloud Audit Logs', 'gov'));
      a.security.auditTargets.forEach(t => L.push(`${t} -. data access .-> Audit`));
    }

    L.push(node('Obs', 'Observability', 'obs'));
    L.push('AE -. traces .-> Obs');

    if (a.topology.perimeterOn) L.push('end');

    /* ---- cross-boundary edges (after the perimeter closes) ---- */
    if (!privateOnly) L.push(cacheOn ? `Cache -- miss --> ${a.agent.agentEntry}` : `${head} --> ${a.agent.agentEntry}`);
    if (a.gov.hitlApproval !== 'none') {
      L.push(node('Appr', 'Human review', 'gov'));
      if (auto) {
        L.push(`${a.agent.agentReview} -. await human .-> Appr`);
        L.push(`Appr -. resume on approve .-> ${a.agent.agentEntry}`);
      } else {
        L.push(`${a.agent.agentReview} -. review .-> Appr`);
      }
    }
    if (!auto && a.gov.feedbackLoop) {
      L.push(node('Fb', 'Feedback → Agent Platform evals', 'gov'));
      L.push('Obs -. evals .-> Fb');
    }

    /* ---- hybrid: on-prem network over Cloud Interconnect, the sole ingress ---- */
    let onpremDrawn = false;
    if (a.topology.hybridLink) {
      onpremDrawn = true;
      const hasOnpremData = a.retrieval.liveSel.includes('onprem');
      L.push('subgraph ONPREM["On-premise"]');
      L.push(node('OnpremUsers', 'On-prem users / network', 'client'));
      if (hasOnpremData) L.push(node('OnpremDB', 'On-prem systems / DB', 'data', 'cyl'));
      L.push('end');
      L.push('OnpremUsers == Cloud Interconnect ==> CloudRouter');
      const edge = a.models.inboundChips.length ? `-- ${C().LIGHT_AUTH} -->` : '-->';
      if (cacheOn) {
        L.push(`CloudRouter ${edge} Cache`);
        L.push('Cache -- hit --> OnpremUsers');
        L.push(`Cache -- miss --> ${a.agent.agentEntry}`);
      } else {
        L.push(`CloudRouter ${edge} ${a.agent.agentEntry}`);
      }
      if (hasOnpremData) L.push(`${a.agent.dataAgent} == over interconnect ==> OnpremDB`);
    }

    /* ---- styling ---- */
    const dp = C().DIAGRAM_PALETTE[theme === 'light' ? 'light' : 'dark'];
    if (a.topology.perimeterOn) L.push(`style PERIM stroke:${dp.perim},stroke-dasharray: 4 4,fill:transparent;`);
    if (a.topology.vpcDrawn) L.push(`style VPC stroke:${dp.vpc},stroke-width:2px,fill:transparent;`);
    if (onpremDrawn) L.push(`style ONPREM stroke:${dp.client.stroke},stroke-dasharray: 6 3,fill:transparent;`);
    for (const k of ['client', 'gateway', 'orch', 'retr', 'data', 'obs', 'gov']) {
      L.push(`classDef ${k} fill:${dp[k].fill},stroke:${dp[k].stroke},color:${dp[k].color};`);
    }
    L.push(...cls);
    return L.join('\n');
  }

  /* Parse the box nodes out of a mermaid source string (id -> readable label).
     Used by the self-test and, later, baseline diffs. */
  function diagramNodeMap(src) {
    const m = new Map();
    if (!src) return m;
    src.split('\n').forEach(line => {
      if (/^\s*subgraph\b/.test(line)) return;
      const re = /(\w+)\[\(?"([^"]*)"\)?\]/g;
      let g;
      while ((g = re.exec(line)) !== null) {
        const label = g[2].replace(/<br\/?>/g, ' ').replace(/\s+/g, ' ').trim();
        m.set(g[1], label);
      }
    });
    return m;
  }

  NS.diagram = { buildDiagram, diagramNodeMap };
})(typeof window !== 'undefined' ? (window.ASD2 = window.ASD2 || {}) : (globalThis.ASD2 = globalThis.ASD2 || {}));
