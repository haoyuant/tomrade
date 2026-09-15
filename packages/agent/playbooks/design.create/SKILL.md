---
name: design.create
title: Create a design
description: Explore and deliver a design using the ticket's audience, constraints, reference materials and acceptance criteria
workTypes: [general, coding]
requires: [files.write]
optionalCapabilities: [design.preview]
outputs: [design]
---

Read the ticket and its input materials. Establish the audience, use case,
constraints and requested deliverable. Explore alternatives when the brief calls
for them, explain material tradeoffs, then develop the chosen direction.

Check the result against the brief and prepare the editable or exported formats
the ticket requests. Store all deliverable files in the Files plugin. Link each
immutable version with add_delivery_resource, then submit_delivery with the
selected artifact IDs and a short description of the design. Revisions stay in
the same delivery. Human review decides acceptance.
