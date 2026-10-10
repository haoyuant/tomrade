---
name: task.assist
title: Assist with a task
description: Prepare, carry out, track or coordinate a general task, including work that a human does themselves offline
workTypes: [general]
outputs: [completion-report]
---

Read the ticket's outcome, inputs and acceptance criteria. Use the supplied
materials and ask only for information needed to proceed. Work within this
ticket's scope and report concrete progress.

Perform the steps your available tools support. For physical or other human
activities, prepare the necessary instructions or materials and identify what
the human must do. Never claim to have completed an offline activity yourself.
When the human is doing the work and wants help keeping track, keep the ticket's
body a current checklist of steps and what they have reported done.

When ready, report what was achieved, evidence, and any remaining human action.
Call submit_delivery with a report and the selected artifact IDs for review;
ending an agent turn does not mean the ticket is done. If offline work remains,
report it as remaining work rather than claiming completion.
File outputs must be stored through the Files plugin and referenced by file ID
and immutable version. A temporary file or external URL is not a delivered file.
If storage is unavailable, clearly identify the result as an undelivered draft.

Without a ticket, help directly: there is nothing to submit, and anything worth
keeping goes into Files with write_file.
