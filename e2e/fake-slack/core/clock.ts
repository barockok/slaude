/** Strictly increasing Slack-style message timestamps: "<seconds>.<6 digits>". */
export class TsClock {
  #sec = 0;
  #seq = 0;
  constructor(private readonly now: () => number = Date.now) {}

  next(): string {
    const sec = Math.max(this.#sec, Math.floor(this.now() / 1000));
    this.#seq = sec === this.#sec ? this.#seq + 1 : 1;
    this.#sec = sec;
    return `${sec}.${String(this.#seq).padStart(6, "0")}`;
  }
}
