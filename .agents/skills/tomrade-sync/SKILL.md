---
name: tomrade-sync
description: "Bring this session's work back into the Tomrade backlog (project \"Tomrade\") when the user asks to sync with Tomrade — match it to tickets, link code, update status, file follow-ups."
---

Sync this session's work back to Tomrade, the backlog of project "Tomrade" (ticket keys look like TOM-42).

1. Gather what this session did: what was built, changed, decided or found — from the conversation and, in a git repository, from the current branch, its commits not on the default branch, and any pull request.
2. Match the work to tickets. A key in the branch, a commit, the pull request or the conversation settles it (get_item). Without one, search list_items with one or two distinctive words and take only a ticket that clearly describes this work. Work that matches no ticket stays unmatched, and that is fine.
3. Before writing, show the user a short list: what you will change on each ticket, and any follow-up tickets you would file. When every match came from a key and nothing new would be filed, go ahead; otherwise wait for the user to confirm or adjust.
4. Write:
   - Code: link_code with the branch, and the pull request URL if there is one. From then on Tomrade reads the status from git (commits → Doing, open pull request → Verifying, merge → Done); never mark a code ticket done yourself.
   - Work without code: change_status to doing once it has started, or submit_delivery with a short report when it is finished and needs the user's review. Mark it done only when the user says so: once a delivery is submitted, that is review_delivery with their words in userSaid, never change_status.
   - Progress: note_progress with one line, when Tomrade tracks this session; if it answers that it does not, skip it.
   - Follow-ups: create_item, one per separate piece of work this session found but did not do. Do not file a ticket for finished work unless the user asks for one.
5. End with a short summary: each ticket and what changed on it, the keys of new tickets, and the work you left unmatched.
