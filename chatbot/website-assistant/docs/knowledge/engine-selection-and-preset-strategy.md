# Engine Selection And Preset Strategy

Status: compact product guidance; strategy sections are provisional

Purpose:
Give Assistant a small starting point for helping users choose an engine and build a preset without pretending that frontend labels prove runtime quality.

## Verified Product Map

APICostX exposes these generation sections in the preset UI: FPF, GPT-R, DR, MS-Agent, AIQ, OWL, Translation Agent, Marian NMT, and PDFMathTranslate. Eval and Combine are separate sections that can operate on generated results.

Presets combine source material, generation instructions, model selections, engine settings, optional evaluation, and optional combining. The page supports Content Library or GitHub input, shows an LLM-call estimate, and keeps Save separate from Execute.

## Starter Choices

These are starting heuristics, not guarantees:

- Use FPF when the user has known source material and wants controlled document generation.
- Use GPT-R or DR when the main need is web-oriented research; start with GPT-R for a simpler research shape and DR when branching depth and breadth are intentional.
- Use MS-Agent or AIQ when the user specifically needs multi-role or multi-stage agent controls and accepts more configuration.
- Use OWL when the user wants the isolated OWL workflow exposed by the UI.
- When explaining OWL, read the `camel-owl-engine` knowledge topic. APICostX's OWL preset generator is a CAMEL-AI research workforce; it is not the Allie Owl chatbot API. Do not claim a configured engine, model, successful run, output quality, or cancellation support without live evidence.
- Use Translation Agent, Marian, or PDFMathTranslate for translation-specific work; choose PDFMathTranslate when the input/output requirement is a translated PDF.
- Add Eval when comparing generated candidates matters. Add Combine only when there is a clear reason to synthesize several outputs.

## Safe First Preset Recipe

Start with one engine, one or two models, one clear input document, and one generation-instructions asset. Run the visible runnability check, review the call estimate, and begin with a modest effort profile or iteration count. Add more engines, documents, evaluation, or combining only when the first result shows a specific need.

## Do Not Overclaim

The frontend shows controls, estimates, labels, and compatibility filters, but it does not prove runtime quality, provider access, pricing accuracy, backend enforcement, or execution success. Treat model rankings, cost/quality claims, exact engine behavior, and “best” recipes as unverified until supported by measured runs.
