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
An active delivery's type cannot change; finish or cancel it first. Historical
deliveries and their evidence remain when changing type for future work.

**Artifact**:
An output resource in a delivery, referencing a stable Files `fileId` and an
immutable `versionId`. Input materials are separate ticket resources. All actual
files belong to the future Files plugin; ticket metadata is not a file store.

**Submission / Review**:
A submission pins a report and selected output resources. Human review accepts
it or requests changes. Revisions stay in the same delivery; reopening completed
or cancelled work creates the next delivery. General engine success is not human
acceptance. Mixed Coding/artifact work requires all code links merged and human
acceptance; pure Coding follows the associated repositories' completion policy.

**Playbook**:
A versioned execution method, not a ticket type or a permission grant. Its
declared capabilities gate execution; recommendations guide selection without
rigid type dispatch. Plugin/user/project SKILL.md source precedence remains.
Runs retain method provenance. A General delivery resumes its pinned method
unless a person explicitly chooses another. Humans can execute tickets directly
or take over from an agent without abandoning delivery history.

Concurrent independent evidence additions merge. Incompatible deliveries,
conflicting reviews or undo that would break submitted references stop sync for
reconciliation rather than silently declaring a false completion.
