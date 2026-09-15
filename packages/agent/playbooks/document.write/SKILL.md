---
name: document.write
title: Write a document
description: Produce or revise a document using the ticket's materials, audience and acceptance criteria
workTypes: [general, coding]
requires: [files.write]
optionalCapabilities: [document.preview]
outputs: [document]
---

Read the goal, audience, source materials, constraints and acceptance criteria.
Identify missing facts that would materially change the document. Use reasonable
editorial defaults for ordinary choices and ask about unresolved requirements.

Organize the document around its reader's needs, draft it, then check factual
support, completeness, consistency and formatting. Revise within the same
delivery when review requests changes.

Store the document through the Files plugin. Call add_delivery_resource with
the resulting file ID and immutable version as an output artifact, then call
submit_delivery with the artifact ID and a concise
description of what was produced. Do not create an alternative attachment store,
claim that a local path is a delivered artifact, or mark the ticket done yourself.
