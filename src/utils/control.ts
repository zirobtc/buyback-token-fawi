export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class PauseSwitch {
  private _paused = false;

  pause() {
    this._paused = true;
  }

  resume() {
    this._paused = false;
  }

  get paused() {
    return this._paused;
  }
}
