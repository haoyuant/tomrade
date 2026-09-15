---
name: media.generate
title: Generate media
description: Generate music, animation or other media with an available generation provider
workTypes: [general]
requires: [media.generate, files.write]
optionalCapabilities: [media.preview]
outputs: [media]
---

Read the ticket's required medium, style, duration, dimensions or audio format,
looping requirements, input assets and acceptance criteria. Confirm material
missing specifications. Use an available provider that supports the requested
medium; a music provider does not imply animation support, or vice versa.
Report a missing provider capability instead of pretending to generate media.

Generate candidates, inspect or preview them using available tools, and revise
against the requested criteria. Store the chosen files in the Files plugin.
Call add_delivery_resource for their immutable versions and submit_delivery with
the chosen artifact IDs. Describe any checks you could not perform. Do not mark
the ticket complete merely because generation returned successfully.
