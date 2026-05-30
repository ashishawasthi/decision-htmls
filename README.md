# Gen AI System Decisions on Google Cloud

A set of HTML tools for reasoning about how to build and run
generative AI workloads on Google Cloud. Each tool is a single 
HTML file that opens straight from disk.

## Tools

| File | What it answers |
| ---- | --------------- |
| [index.html](index.html) | Landing page that links to the three tools below. |
| [agentic-system-designer.html](agentic-system-designer.html) | How to build it. Toggle purpose, scale, latency target, retrieval, and governance, and a reference architecture on Google Cloud recomputes live: component diagram, sizing, cost and latency, and what breaks at scale. |
| [agent-infra-cost-calculator.html](agent-infra-cost-calculator.html) | Where to run it. Compare Vertex AI managed APIs against GCP self-host on GPU VMs against an on-premise H100 cluster, with a three-year cumulative cost view. |
| [qlora-gemma4-memory-calculator.html](qlora-gemma4-memory-calculator.html) | Whether it fits. Pick the memory-saving levers (quantization, LoRA rank, optimizer, batch size, sequence length, checkpointing) and see the estimated peak GPU memory and which GPUs fit. |

## Notes

- Every estimate is deterministic. No model is called at runtime.
- Pricing and heuristics reflect roughly May 2026 and are meant for planning, not billing.
