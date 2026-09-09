# Presets and executions

Preset work follows this order: identify the user's intent, inspect existing
presets or content when needed, validate the chosen preset, explain any launch
problem, and execute only after the user explicitly confirms execution.

A saved preset can refer to input documents and instruction/criteria content.
Generation can use FPF, GPT-R, Deep Research, MS-Agent, AIQ, OWL, Translation
Agent, Marian, or PDFMathTranslate where the selected configuration supports
them. Evaluations and Combine are separate phases; a generated report is not
the same thing as a completed run.

After execution, use the run status, durable phase progress, logs, generated
outputs, and cost summary to answer what happened. A tool response or model
claim is not proof of a saved preset, completed run, or generated output.

