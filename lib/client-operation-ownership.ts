/**
 * Synchronous ownership for one browser-side scan lifecycle operation.
 *
 * React state does not update synchronously, so it cannot prevent two submit
 * handlers in the same turn from both minting an admission credential and
 * creating work. A lease is claimed before an async operation begins; every
 * callback and finalizer must still own that exact lease before mutating state
 * or recovery storage.
 */
export type ClientOperationLease<Kind extends string = string> = Readonly<{
  token: number;
  kind: Kind;
  controller: AbortController;
}>;

export class ClientOperationOwner<Kind extends string = string> {
  private nextToken = 0;
  private currentLease: ClientOperationLease<Kind> | null = null;

  current(): ClientOperationLease<Kind> | null {
    return this.currentLease;
  }

  claim(kind: Kind): ClientOperationLease<Kind> | null {
    if (this.currentLease !== null) return null;
    const lease = this.createLease(kind);
    this.currentLease = lease;
    return lease;
  }

  /** Abort and fence the old owner before installing a newer operation. */
  supersede(kind: Kind): ClientOperationLease<Kind> {
    const previous = this.currentLease;
    // Install the newer owner before abort dispatch, which is synchronous and
    // can invoke listeners. Re-entrant claims therefore stay blocked and no
    // listener can occupy the handoff gap.
    const lease = this.createLease(kind);
    this.currentLease = lease;
    previous?.controller.abort();
    return lease;
  }

  owns(lease: ClientOperationLease<Kind>): boolean {
    return this.currentLease === lease && this.currentLease.token === lease.token;
  }

  /** Release only the exact owner; a stale finalizer cannot clear a newer one. */
  release(lease: ClientOperationLease<Kind>): boolean {
    if (!this.owns(lease)) return false;
    this.currentLease = null;
    return true;
  }

  /** Abort only the exact owner; an old effect cleanup cannot abort a new one. */
  cancel(lease: ClientOperationLease<Kind>): boolean {
    if (!this.owns(lease)) return false;
    lease.controller.abort();
    // Abort listeners cannot claim while this lease remains installed. A
    // deliberate listener-side supersede is allowed and must not be cleared.
    if (this.currentLease === lease) this.currentLease = null;
    return true;
  }

  /** User dismissal/unmount invalidates whichever operation currently owns the lifecycle. */
  cancelCurrent(): ClientOperationLease<Kind> | null {
    const current = this.currentLease;
    if (current !== null) this.cancel(current);
    return current;
  }

  private createLease(kind: Kind): ClientOperationLease<Kind> {
    return Object.freeze({
      token: ++this.nextToken,
      kind,
      controller: new AbortController()
    });
  }
}

/** An awaited callback uses AbortError semantics when its lease was superseded. */
export function assertClientOperationOwner<Kind extends string>(
  owner: ClientOperationOwner<Kind>,
  lease: ClientOperationLease<Kind>
): void {
  if (!owner.owns(lease) || lease.controller.signal.aborted) {
    const error = new Error("This scan operation was superseded.");
    error.name = "AbortError";
    throw error;
  }
}
