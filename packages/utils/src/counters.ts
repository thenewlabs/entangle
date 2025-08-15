export class MonotonicCounter {
  private lastSeen: number = -1;
  
  validate(ctr: number): void {
    if (ctr <= this.lastSeen) {
      throw new Error(`Counter not strictly increasing: ${ctr} <= ${this.lastSeen}`);
    }
    this.lastSeen = ctr;
  }
  
  next(): number {
    return ++this.lastSeen;
  }
  
  current(): number {
    return this.lastSeen;
  }
}

export class BidirectionalCounters {
  readonly incoming = new MonotonicCounter();
  readonly outgoing = new MonotonicCounter();
}