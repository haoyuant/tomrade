/** Write-path errors. All AI-vs-human conflicts surface as typed errors. */
export class ConflictError extends Error {
  constructor(public readonly itemId: string, public readonly expectedVersion: number, public readonly actualVersion: number) {
    super(`Item ${itemId} version conflict: expected ${expectedVersion}, got ${actualVersion} (it was edited by someone else)`);
    this.name = "ConflictError";
  }
}

export class HumanLockedError extends Error {
  constructor(public readonly itemId: string, public readonly fields: string[]) {
    super(`Item ${itemId} is human-locked; AI may not edit fields: ${fields.join(", ")}`);
    this.name = "HumanLockedError";
  }
}

export class NotFoundError extends Error {
  constructor(public readonly itemId: string) {
    super(`Item ${itemId} not found`);
    this.name = "NotFoundError";
  }
}

/** A destructive write refused because something still depends on the target. */
export class InUseError extends Error {
  constructor(
    public readonly entityId: string,
    public readonly reason: string
  ) {
    super(reason);
    this.name = "InUseError";
  }
}
