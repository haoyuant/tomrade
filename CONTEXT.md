# Tomrade

Tomrade keeps backlog intent and code-delivery evidence connected without making a coding agent the source of truth.

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
