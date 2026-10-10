# Tomrade

Tomrade connects planned outcomes, execution and delivery evidence without making an agent the source of truth. Tickets can cover code, documents, design, media, or human offline work.

## Language

**Ticket**:
A planned outcome whose status reflects the current delivery, while retaining the history of earlier deliveries.
_Avoid_: Issue, task

**Delivery**:
One attempt to deliver a ticket. A ticket has at most one active delivery; completed or cancelled deliveries remain as history and do not drive its current status.
_Avoid_: Attempt, cycle, round

**Code link**:
A branch and its pull request evidence within one delivery. A delivery may contain multiple code links.
_Avoid_: Attachment, association

**Work type**:
`coding` or `general`, independent of structural `kind` (`ticket` or `epic`).
Coding links to repositories, branches and PRs. General requires none of those.
A new ticket without one is coding when its workstream has a repository and
general when it has none. An active delivery's type cannot change; finish or cancel it first. Historical
deliveries and their evidence remain when changing type for future work.

**Artifact**:
An output resource in a delivery, referencing a stable Files `fileId` and an
immutable `versionId`. Input materials are separate ticket resources. All actual
files belong to the Files plugin (`@tomradex/files`); ticket metadata is not a file store.

**Submission / Review**:
A submission pins a report and selected output resources. Human review accepts
it or requests changes. Revisions stay in the same delivery; reopening completed
or cancelled work creates the next delivery. General engine success is not human
acceptance: a General delivery with a submission, or one an agent ran, is closed
by a person. One nobody delegated or submitted (a task the person tracks and does
themselves) may be closed by an agent on the person's word. Mixed Coding/artifact work requires all code links merged and human
acceptance; pure Coding follows the associated repositories' completion policy.

**Playbook**:
A versioned execution method, not a ticket type or a permission grant. Its
declared capabilities gate execution; recommendations guide selection without
rigid type dispatch. Plugin/user/project SKILL.md source precedence remains.
Runs retain method provenance. A General delivery resumes its pinned method
unless a person explicitly chooses another. Humans can execute tickets directly
or take over from an agent without abandoning delivery history. Built-in methods
also work without a ticket, saving into Files with nothing to submit.

**Dependency**:
`blocks` / `blockedBy` between items. Information, not a lock: people move a
blocked ticket freely. Starting an agent on a ticket that waits on open work
asks first (`allowBlocked`); once started, the agent is told what is still open
on every turn and is never stopped for it. After an agent creates, deletes,
cancels or re-scopes tickets, the assistant checks whether dependencies should
change and asks before writing them. A ticket whose goal changes substantially
is cancelled and replaced by a new one, and its dependencies move to the
replacement.

Concurrent independent evidence additions merge. Incompatible deliveries,
conflicting reviews or undo that would break submitted references stop sync for
reconciliation rather than silently declaring a false completion.
