export class RestartCoordinator {
  private restarting = false;
  private inFlight = new Set<string>();

  requestRestart(): void {
    this.restarting = true;
  }

  isRestarting(): boolean {
    return this.restarting;
  }

  track(id: string): void {
    this.inFlight.add(id);
  }

  untrack(id: string): void {
    this.inFlight.delete(id);
  }

  getInFlightCount(): number {
    return this.inFlight.size;
  }

  async waitForDrain(graceMs: number): Promise<boolean> {
    if (this.inFlight.size === 0) {
      return true;
    }

    if (graceMs <= 0) {
      return false;
    }

    return new Promise<boolean>((resolve) => {
      const startTime = Date.now();
      const check = () => {
        if (this.inFlight.size === 0) {
          resolve(true);
          return;
        }
        if (Date.now() - startTime >= graceMs) {
          resolve(false);
          return;
        }
        setTimeout(check, 10);
      };
      setTimeout(check, 10);
    });
  }
}