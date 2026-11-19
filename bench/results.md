# Benchmark results

- **Date:** 2026-11-19
- **Setup:** subscription
- **Tasks:** 115 (seed 7)
- **CLI preamble:** 929 tokens per call, measured and removed so costs match direct API calls
- **Classifier:** ollama/qwen2.5:7b
- **Tiers:** cheap ollama/qwen2.5:7b · mid claude-cli/claude-haiku-5-5 · frontier claude-cli/claude-sonnet-5-5
- **Prices:** prices.json, as of 2026-11-19

| Arm | Tasks | Success | Errors | Cost | Cost / task | p50 latency | p95 latency |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| frontier | 115 | 100% | 0 | $0.182 | $0.00158 | 3.3 s | 6.5 s |
| routed | 115 | 92% | 0 | $0.016 | $0.00014 | 4.2 s | 8.3 s |

**Cost saving from routing: 91%**

## Success by task kind

| Kind | Frontier | Routed | Routed to |
| --- | ---: | ---: | --- |
| extract | 100% | 100% | qwen2.5:7b ×15 |
| arithmetic | 100% | 100% | qwen2.5:7b ×10 |
| json | 100% | 100% | qwen2.5:7b ×15 |
| date | 100% | 47% | qwen2.5:7b ×15 |
| gsm8k | 100% | 98% | qwen2.5:7b ×22, claude-haiku-5-5 ×18 |
| ordering | 100% | 100% | claude-haiku-5-5 ×18, claude-sonnet-5-5 ×2 |

## Routing

- Complexity scores: 1: 3 · 2: 74 · 3: 36 · 4: 2
- Classifier fallbacks (default model used): 0
- Average classifier time: 426 ms
- Misroutes (frontier passed, cheaper model failed): 9
  - date-0 (date) → qwen2.5:7b, complexity 2
  - date-3 (date) → qwen2.5:7b, complexity 2
  - date-4 (date) → qwen2.5:7b, complexity 2
  - date-6 (date) → qwen2.5:7b, complexity 2
  - date-7 (date) → qwen2.5:7b, complexity 2
  - date-10 (date) → qwen2.5:7b, complexity 2
  - date-11 (date) → qwen2.5:7b, complexity 2
  - date-13 (date) → qwen2.5:7b, complexity 2
  - gsm8k-990 (gsm8k) → claude-haiku-5-5, complexity 3
