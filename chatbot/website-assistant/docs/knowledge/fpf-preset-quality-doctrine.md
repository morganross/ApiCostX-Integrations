# FPF Preset Quality Doctrine

Status: authoritative v1

Purpose:
Teach Assistant what makes an FPF preset useful, not merely runnable.

## What FPF Is For

FPF is the ACM engine for turning selected input documents and generation instructions into generated documents.

Use FPF when the user needs controlled content generation from known source material, topic briefs, notes, uploaded documents, or other content-library input records.

For the current advanced-assistant milestone, FPF preset creation is intentionally narrow:

- FPF only
- model `openai:gpt-5-mini`
- database content-library input documents
- one generation-instructions asset
- at least one input-document asset
- no GPT Researcher, DR, MS-Agent, AIQ, eval, combine, translation, OWL, Marian, or PDF translation

## The Difference Between Instructions And Input Documents

Generation instructions tell FPF how to write.

Input documents tell FPF what to write from.

Do not blur these roles. A good preset needs both:

- the instruction asset defines purpose, audience, tone, structure, source-use rules, constraints, uncertainty policy, forbidden behavior, and output format
- the input-document asset provides topic facts, source material, user goals, assumptions, questions to answer, and missing context to handle carefully

## What A Good FPF Preset Does

A good FPF preset turns a user goal into a repeatable workflow.

It should answer these questions:

- What is the user trying to produce?
- Who is the intended reader?
- What source material should the model rely on?
- What shape should the final output have?
- What claims are allowed, inferred, uncertain, or forbidden?
- What should the model do when the input is thin?
- What should make the output feel successful?

## Good Generation Instructions

Strong FPF generation instructions should include:

- a clear mission statement
- an assumed audience, with a fallback if the user did not specify one
- a source-use policy that says the attached input document is the authority
- an uncertainty policy for thin, missing, or ambiguous source material
- a required output structure
- tone and style guidance
- constraints and forbidden behavior
- a quality checklist the output should satisfy before finishing

Do not write instructions that merely say "write about the topic." That is runnable but weak.

## Good Input Documents

When Assistant creates a new input document from only a user goal, it should make the limitation explicit.

The input document should contain:

- the user's goal or topic
- the desired output objective
- assumed audience
- known constraints from the user message
- starter questions the output should answer
- source boundaries explaining that the topic brief is thin unless the user later adds richer material
- missing details that the model should not invent

The input document should not pretend to contain external research or verified facts that the user did not provide.

## Quality Checklist

Before treating a from-scratch FPF preset as good, not just runnable, Assistant should check:

- FPF is the only intended engine for this milestone.
- The selected model is `openai:gpt-5-mini`.
- A generation-instructions asset is selected.
- At least one input-document asset is selected.
- The input source is database content.
- Instructions define purpose, audience, source rules, uncertainty handling, forbidden behavior, and output format.
- The input document clearly separates known user-provided material from assumptions and missing details.
- The output contract is specific enough for repeatable use.

## When To Ask Follow-Up Questions

For the current milestone, Assistant may create a reasonable first draft without asking follow-up questions when the user asks it to make a preset.

However, Assistant should mention useful future refinements when the user's goal is thin:

- target audience
- desired length
- required sections
- tone
- source documents to add
- examples of good output
- facts or constraints that must not be invented

## Response Pattern After Creating A Preset

After creating an FPF preset from scratch, Assistant should report:

- preset name
- saved preset id when available
- instruction asset name and id
- input-document asset name and id
- engine and model
- whether it appears runnable
- what quality limitations remain

Do not overclaim output quality just because the preset is runnable. Runnability means the system can execute; quality means the instruction and input assets are semantically strong enough to produce useful work.
