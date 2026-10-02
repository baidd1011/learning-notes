# Scientific architecture illustration

Generated with the built-in image_gen tool. Conceptual architecture illustration; not a quantitative chart. Callout numbers verified against results/matrix/summary.json. The QuickJS node summarizes both discovery and business script executions, not a single execution instance.

## Generation prompt

Scientific-educational architecture schematic for a technical article. Generate a single polished landscape figure, white background, elegant NeurIPS/ICML/OSDI paper aesthetic: vector-like crisp flat diagrams, thin charcoal strokes, lots of whitespace, professional sans-serif typography, muted blue for Pi Codemode and burnt orange for Harness PTC. No 3D, no robots, no logo, no gradients, no decorative marketing style. Title: "Pi Codemode vs. Harness PTC". Subtitle: "Interfaces, execution, and model-visible output".
Two equal architecture panels occupy 75% of the image:
(a) Pi Codemode: a model-context area on top and host/execution area below, separated by a dashed line. Show the model stages "Discover" -> "Generate program" -> "Answer". Initially only "codemode + server summary" in context. Below, "Tool index" with "searchTools / describeTool"; a clear arrow returns only "Selected declarations" to model. Generated program runs in "QuickJS-WASM"; it invokes "Host tool bridge", which invokes the shared read-only MCP service. Tool results return to program variables. Within QuickJS label "await tools.…", "filter / aggregate", "text(summary)". Only "Compact output" returns to Answer. Indicate MCP binding returns "CallToolResult" and program unwraps it. Do NOT send raw tool results to the model.
(b) Harness PTC: model stages "Generate program" -> "Answer". Initially "run_code + complete visible SDK" in context. A host "Tool registry" -> "SDK generator" supplies SDK text to the model. Generated code runs in "Node PTC process"; tool bindings use a "Control channel" to reach "Host scheduler / MCP bridge", which invokes the same MCP service. The bridge unwraps MCP wrapper into "Canonical JSON". Raw results return to program variables, NOT model context. Within Node label "await tools.…", "filter / aggregate", "return summary". Only "Compact return value" reaches Answer. Small host-only side label "Dispatch logs".
One shared bottom architecture box "Same read-only MCP service" connects to both host bridges. All tool capability access crosses host bridges, no direct network arrow from QuickJS. Arrow flow clear with no crossings. Small architecture caption: "Tested strategy: discovery-first vs. preloaded SDK". These are two and three model stages under the benchmark strategy, not universal minimums.
(c) Below architecture, three simple evidence callout cards, no chart axes:
Card 1 exact text: "12 orders · 60 tools", "Input tokens (median)", "Codemode: 6,093", "PTC: 16,778", "63.7% less input".
Card 2 exact text: "9 configurations · 3 repeats", "PTC lower median latency: 9/9", "8.9–36.5% lower".
Card 3 exact text: "3 tools", "PTC uses less input", "Codemode: 21.1–43.0% more input".
Footer exact text: "108 validated tasks. Cached input included. Tested prompts and unequal concurrency limits; not a universal ranking."
Render all numbers exactly. No invented values, error bars or claims. Architecture is the main focus. English labeling is intentional for publication readability. High resolution, clean editorial academic design.

## Final correction prompt

Edit this image while preserving every box, statistic, number, typography and color. In the LEFT BLUE Pi Codemode panel, completely erase the stray text 'run_code(code)' beside the compact-output arrow; Pi does not use run_code. In the RIGHT ORANGE Harness PTC panel, erase the LEFT of the two downward arrows from Generate program into Node PTC process, together with that arrow's 'Program source' text. Keep the right downward arrow and 'run_code(code)' text. Change nothing else.

