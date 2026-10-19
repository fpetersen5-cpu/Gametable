export class IllegalAction extends Error {
  constructor(
    readonly seatId: string,
    readonly action: unknown,
    message: string,
  ) {
    super(message);
    this.name = 'IllegalAction';
  }
}

export class UnknownSeat extends Error {
  constructor(seatId: string) {
    super(`unknown seat: ${seatId}`);
    this.name = 'UnknownSeat';
  }
}

export class ControllerTimeout extends Error {
  constructor(seatId: string, ms: number) {
    super(`seat ${seatId} did not act within ${ms}ms`);
    this.name = 'ControllerTimeout';
  }
}
