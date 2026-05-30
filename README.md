# Decision tools for GenAI on Google Cloud

A small set of interactive HTML tools for reasoning about how to build and run
generative AI workloads on Google Cloud. Each tool is a single HTML file with its
CSS and JavaScript inline, and there is no build step. The landing page, the cost
calculator, and the memory calculator are fully self-contained and open straight
from disk. The Agentic System Designer is the exception: it loads a diagram
library from a CDN, so it needs to be served over HTTP and needs internet access
(the section below explains why).

## Tools

| File | What it answers |
| ---- | --------------- |
| [index.html](index.html) | Landing page that links to the three tools below. |
| [agentic-system-designer.html](agentic-system-designer.html) | How to build it. Toggle purpose, scale, latency target, retrieval, and governance, and a reference architecture on Google Cloud recomputes live: component diagram, sizing, cost and latency, and what breaks at scale. |
| [agent-infra-cost-calculator.html](agent-infra-cost-calculator.html) | Where to run it. Compare Vertex AI managed APIs against GCP self-host on GPU VMs against an on-premise H100 cluster, with a three-year cumulative cost view. |
| [qlora-gemma4-memory-calculator.html](qlora-gemma4-memory-calculator.html) | Whether it fits. Pick the memory-saving levers (quantization, LoRA rank, optimizer, batch size, sequence length, checkpointing) and see the estimated peak GPU memory and which GPUs fit. |

Each tool page has a back control at the top left that returns to the landing page.

## Viewing the tools

Three of the four pages open straight from disk: double-click the file, or open
it in a browser. The landing page, the cost calculator, and the memory calculator
all work this way, and the links between pages work too.

The Agentic System Designer is the exception. Its whole app runs as an ES module
that imports the Mermaid diagram library from a CDN. Browsers restrict ES modules
loaded over file:// (Chrome blocks them), so this page can fail to run when opened
from disk, and it needs internet access for the library. Serve it over HTTP
instead.

To start a local server, run either of these from the repository root:

```
python3 -m http.server 8765
```

```
node .claude/serve.js 8765
```

Then open http://localhost:8765/ and the landing page loads.

The bundled `.claude/serve.js` is a small static server that always serves this
folder. The included `.claude/launch.json` runs it under the name `site` so the
Claude Code preview tooling can start it for you.

## Notes

- Every estimate is deterministic. No model is called at runtime.
- Pricing and heuristics reflect roughly May 2026 and are meant for planning, not billing.
