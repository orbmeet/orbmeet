export class RoomManagerUnavailableError extends Error {
  constructor(message = "Whiteboard room manager is unavailable") {
    super(message);
    this.name = "RoomManagerUnavailableError";
  }
}

export class RoomCapacityError extends Error {
  constructor() {
    super("Maximum concurrent whiteboard rooms reached");
    this.name = "RoomCapacityError";
  }
}
