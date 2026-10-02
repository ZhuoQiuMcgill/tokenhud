// A minimal terminal emulator for the pty checks: enough of VT100/xterm to replay what
// OpenTUI writes (cursor positioning, erase, SGR, private modes, OSC/DCS strings) into a
// character grid, and to report the state a program leaves the terminal in.

export class Vt {
  readonly cols: number;
  readonly rows: number;
  #main: string[][];
  #alt: string[][];
  #grid: string[][];
  #x = 0;
  #y = 0;
  #saved: [number, number] = [0, 0];
  /** Whether the alternate screen is active. */
  altScreen = false;
  cursorVisible = true;
  /** Private modes last set (h) or reset (l), e.g. 1049, 25, 2004. */
  readonly modes = new Map<number, boolean>();
  #pending = "";

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.#main = this.#blank();
    this.#alt = this.#blank();
    this.#grid = this.#main;
  }

  #blank(): string[][] {
    return Array.from({ length: this.rows }, () => Array<string>(this.cols).fill(" "));
  }

  /** The visible screen, one string per row, trailing spaces trimmed. */
  screen(): string[] {
    return this.#grid.map((row) => row.join("").trimEnd());
  }

  text(): string {
    return this.screen().join("\n");
  }

  #put(ch: string): void {
    const w = Bun.stringWidth(ch);
    if (w === 0) return;
    if (this.#x + w > this.cols) {
      this.#x = 0;
      this.#lineFeed();
    }
    const row = this.#grid[this.#y] as string[];
    row[this.#x] = ch;
    if (w === 2 && this.#x + 1 < this.cols) row[this.#x + 1] = "";
    this.#x += w;
  }

  #lineFeed(): void {
    if (this.#y < this.rows - 1) {
      this.#y++;
      return;
    }
    this.#grid.shift();
    this.#grid.push(Array<string>(this.cols).fill(" "));
  }

  #csi(params: string, final: string): void {
    const priv = params.startsWith("?");
    const nums = (priv ? params.slice(1) : params)
      .split(";")
      .map((p) => (p === "" ? NaN : Number(p)));
    const n = (i: number, d: number) => (Number.isNaN(nums[i] as number) ? d : (nums[i] as number));
    switch (final) {
      case "H":
      case "f":
        this.#y = Math.min(this.rows - 1, Math.max(0, n(0, 1) - 1));
        this.#x = Math.min(this.cols - 1, Math.max(0, n(1, 1) - 1));
        return;
      case "A":
        this.#y = Math.max(0, this.#y - n(0, 1));
        return;
      case "B":
        this.#y = Math.min(this.rows - 1, this.#y + n(0, 1));
        return;
      case "C":
        this.#x = Math.min(this.cols - 1, this.#x + n(0, 1));
        return;
      case "D":
        this.#x = Math.max(0, this.#x - n(0, 1));
        return;
      case "G":
        this.#x = Math.min(this.cols - 1, Math.max(0, n(0, 1) - 1));
        return;
      case "d":
        this.#y = Math.min(this.rows - 1, Math.max(0, n(0, 1) - 1));
        return;
      case "J": {
        const mode = n(0, 0);
        if (mode === 2 || mode === 3) {
          for (const row of this.#grid) row.fill(" ");
        } else if (mode === 0) {
          (this.#grid[this.#y] as string[]).fill(" ", this.#x);
          for (let y = this.#y + 1; y < this.rows; y++) (this.#grid[y] as string[]).fill(" ");
        }
        return;
      }
      case "K": {
        const row = this.#grid[this.#y] as string[];
        const mode = n(0, 0);
        if (mode === 0) row.fill(" ", this.#x);
        else if (mode === 1) row.fill(" ", 0, this.#x + 1);
        else row.fill(" ");
        return;
      }
      case "s":
        this.#saved = [this.#x, this.#y];
        return;
      case "u":
        [this.#x, this.#y] = this.#saved;
        return;
      case "h":
      case "l": {
        if (!priv) return;
        const on = final === "h";
        for (const mode of nums) {
          if (Number.isNaN(mode)) continue;
          this.modes.set(mode, on);
          if (mode === 25) this.cursorVisible = on;
          if (mode === 1049 || mode === 1047 || mode === 47) {
            if (on && !this.altScreen) {
              this.#alt = this.#blank();
              this.#grid = this.#alt;
              this.altScreen = true;
            } else if (!on && this.altScreen) {
              this.#grid = this.#main;
              this.altScreen = false;
            }
          }
        }
        return;
      }
      default:
        return; // SGR and everything else: no effect on characters
    }
  }

  write(data: string): void {
    const s = this.#pending + data;
    this.#pending = "";
    let i = 0;
    while (i < s.length) {
      const c = s[i] as string;
      if (c === "\x1b") {
        const next = s[i + 1];
        if (next === undefined) {
          this.#pending = s.slice(i);
          return;
        }
        if (next === "[") {
          let j = i + 2;
          while (j < s.length && !/[@-~]/.test(s[j] as string)) j++;
          if (j >= s.length) {
            this.#pending = s.slice(i);
            return;
          }
          const params = s.slice(i + 2, j);
          // Intermediate bytes (e.g. "0 q", ">4;0m") never position anything.
          if (/^[?0-9;]*$/.test(params)) this.#csi(params, s[j] as string);
          i = j + 1;
          continue;
        }
        if (next === "]" || next === "P" || next === "_" || next === "^") {
          // OSC / DCS / APC / PM: up to BEL or ESC \
          let j = i + 2;
          while (j < s.length && s[j] !== "\x07" && !(s[j] === "\x1b" && s[j + 1] === "\\")) j++;
          if (j >= s.length) {
            this.#pending = s.slice(i);
            return;
          }
          i = s[j] === "\x07" ? j + 1 : j + 2;
          continue;
        }
        if (next === "7") this.#saved = [this.#x, this.#y];
        if (next === "8") [this.#x, this.#y] = this.#saved;
        i += next === "(" || next === ")" ? 3 : 2;
        continue;
      }
      if (c === "\r") this.#x = 0;
      else if (c === "\n") this.#lineFeed();
      else if (c === "\b") this.#x = Math.max(0, this.#x - 1);
      else if (c >= " ") {
        const cp = s.codePointAt(i) as number;
        const ch = String.fromCodePoint(cp);
        this.#put(ch);
        i += ch.length;
        continue;
      }
      i++;
    }
  }
}
