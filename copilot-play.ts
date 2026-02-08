import blessed from "blessed";
import fs from "fs";
import os from "os";
import path from "path";
import * as pty from "node-pty";

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
const DEFAULT_PROMPTS = [/^> ?$/, /^copilot> ?$/, /^\u276f ?$/];

type Focus = "game" | "copilot";
type HookState = "busy" | "idle" | "unknown";

class OutputBuffer {
  private lines: string[] = [];
  private partial = "";

  append(text: string) {
    const cleaned = text.replace(ANSI_RE, "").replace(/\r/g, "");
    const parts = cleaned.split("\n");
    if (parts.length === 1) {
      this.partial += parts[0];
      return;
    }
    this.lines.push(this.partial + parts[0]);
    this.lines.push(...parts.slice(1, -1));
    this.partial = parts[parts.length - 1];
    if (this.lines.length > 2000) {
      this.lines = this.lines.slice(-2000);
    }
  }

  snapshot() {
    return this.partial ? [...this.lines, this.partial] : [...this.lines];
  }
}

class Game {
  width = 10;
  height = 6;
  player = { x: 0, y: 0 };
  target = { x: 0, y: 0 };
  score = 0;

  resize(width: number, height: number) {
    this.width = Math.max(5, width);
    this.height = Math.max(5, height);
    this.player.x = Math.min(this.player.x, this.width - 1);
    this.player.y = Math.min(this.player.y, this.height - 1);
    this.placeTarget();
  }

  reset() {
    this.score = 0;
    this.player = { x: Math.floor(this.width / 2), y: Math.floor(this.height / 2) };
    this.placeTarget();
  }

  move(dx: number, dy: number) {
    this.player.x = Math.max(0, Math.min(this.width - 1, this.player.x + dx));
    this.player.y = Math.max(0, Math.min(this.height - 1, this.player.y + dy));
    if (this.player.x === this.target.x && this.player.y === this.target.y) {
      this.score += 1;
      this.placeTarget();
    }
  }

  render(): string[] {
    const grid: string[] = [];
    for (let y = 0; y < this.height; y += 1) {
      let row = "";
      for (let x = 0; x < this.width; x += 1) {
        if (x === this.player.x && y === this.player.y) {
          row += "@";
        } else if (x === this.target.x && y === this.target.y) {
          row += "*";
        } else {
          row += ".";
        }
      }
      grid.push(row);
    }
    return grid;
  }

  private placeTarget() {
    if (this.width <= 1 || this.height <= 1) {
      this.target = { x: 0, y: 0 };
      return;
    }
    while (true) {
      const x = Math.floor(Math.random() * this.width);
      const y = Math.floor(Math.random() * this.height);
      if (x !== this.player.x || y !== this.player.y) {
        this.target = { x, y };
        break;
      }
    }
  }
}

type Args = {
  copilot: string;
  stateFile: string;
  promptPatterns: RegExp[];
  copilotArgs: string[];
};

function parseArgs(argv: string[]): Args {
  const sepIndex = argv.indexOf("--");
  const wrapperArgs = sepIndex >= 0 ? argv.slice(0, sepIndex) : argv;
  const copilotArgs = sepIndex >= 0 ? argv.slice(sepIndex + 1) : [];

  let copilot = "copilot";
  let stateFile =
    process.env.COPILOT_HOOKS_STATE ||
    path.join(os.homedir(), ".copilot", "hooks-state.json");
  const promptPatterns: RegExp[] = [...DEFAULT_PROMPTS];

  for (let i = 0; i < wrapperArgs.length; i += 1) {
    const arg = wrapperArgs[i];
    if (arg === "--copilot" && wrapperArgs[i + 1]) {
      copilot = wrapperArgs[i + 1];
      i += 1;
    } else if (arg === "--state-file" && wrapperArgs[i + 1]) {
      stateFile = wrapperArgs[i + 1];
      i += 1;
    } else if (arg === "--prompt-regex" && wrapperArgs[i + 1]) {
      promptPatterns.push(new RegExp(wrapperArgs[i + 1]));
      i += 1;
    } else if (arg === "--help") {
      printUsage();
      process.exit(0);
    }
  }

  return { copilot, stateFile, promptPatterns, copilotArgs };
}

function printUsage() {
  console.log(`Usage: npm run play -- [wrapper options] -- [copilot args]

Wrapper options:
  --copilot <path>       Path to copilot binary (default: copilot)
  --state-file <path>    Hooks state file (default: ~/.copilot/hooks-state.json)
  --prompt-regex <re>    Extra regex to detect waiting prompt
`);
}

function detectPrompt(lines: string[], patterns: RegExp[]): boolean {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) {
      continue;
    }
    return patterns.some((pattern) => pattern.test(line));
  }
  return false;
}

function readHookState(
  stateFile: string,
  previousMtime: number | null
): { state: HookState; mtime: number | null } {
  try {
    const stat = fs.statSync(stateFile);
    if (previousMtime !== null && stat.mtimeMs === previousMtime) {
      return { state: "unknown", mtime: previousMtime };
    }
    const raw = fs.readFileSync(stateFile, "utf8");
    const parsed = JSON.parse(raw) as { state?: string };
    if (parsed.state === "busy" || parsed.state === "idle") {
      return { state: parsed.state, mtime: stat.mtimeMs };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return { state: "unknown", mtime: previousMtime };
    }
  }
  return { state: "unknown", mtime: null };
}

function sendToCopilot(ptyProcess: pty.IPty, key: blessed.Widgets.Events.IKeyEventArg, ch?: string) {
  const seq = key.sequence;
  if (key.name === "enter") {
    ptyProcess.write("\r");
    return;
  }
  if (key.name === "backspace") {
    ptyProcess.write("\x7f");
    return;
  }
  if (key.name === "up") {
    ptyProcess.write("\x1b[A");
    return;
  }
  if (key.name === "down") {
    ptyProcess.write("\x1b[B");
    return;
  }
  if (key.name === "left") {
    ptyProcess.write("\x1b[D");
    return;
  }
  if (key.name === "right") {
    ptyProcess.write("\x1b[C");
    return;
  }
  if (seq) {
    ptyProcess.write(seq);
    return;
  }
  if (ch) {
    ptyProcess.write(ch);
  }
}

const args = parseArgs(process.argv.slice(2));

const screen = blessed.screen({
  smartCSR: true,
  title: "copilot-play",
});

const logBox = blessed.box({
  top: 0,
  left: 0,
  width: "100%",
  height: "70%",
  border: "line",
  scrollable: true,
  alwaysScroll: true,
  scrollbar: {
    ch: " ",
  },
});

const gameBox = blessed.box({
  bottom: 0,
  left: 0,
  width: "100%",
  height: "30%",
  border: "line",
});

screen.append(logBox);
screen.append(gameBox);

const output = new OutputBuffer();
const game = new Game();
game.reset();

let promptDetected = false;
let hookState: HookState = "unknown";
let hookMtime: number | null = null;
let manualFocus: Focus | null = null;

const ptyProcess: pty.IPty = (() => {
  try {
    return pty.spawn(args.copilot, args.copilotArgs, {
      name: "xterm-color",
      cols: 120,
      rows: 30,
      cwd: process.cwd(),
      env: process.env as NodeJS.ProcessEnv,
    });
  } catch (error) {
    console.error(`Failed to spawn '${args.copilot}'.`);
    console.error(error);
    process.exit(1);
  }
})();

ptyProcess.onData((data) => {
  output.append(data);
  promptDetected = detectPrompt(output.snapshot(), args.promptPatterns);
  render();
});

ptyProcess.onExit(() => {
  output.append("\n[copilot exited]\n");
  render();
});

function layout() {
  const height = screen.height as number;
  const width = screen.width as number;
  const gameHeight = Math.max(8, Math.floor(height / 3));
  const logHeight = height - gameHeight;
  logBox.height = logHeight;
  gameBox.height = gameHeight;
  gameBox.top = logHeight;
  logBox.width = width;
  gameBox.width = width;
  ptyProcess.resize(Math.max(20, width - 2), Math.max(5, logHeight - 2));
}

function render() {
  layout();
  const hookLine = hookState === "unknown" ? "hooks: n/a" : `hooks: ${hookState}`;
  const waiting = promptDetected || hookState === "idle";
  const focus: Focus = manualFocus ?? (waiting ? "copilot" : "game");
  const status = waiting ? "PAUSED" : "RUNNING";

  const lines = output.snapshot();
  logBox.setContent(lines.join("\n"));
  logBox.setScrollPerc(100);

  const gameWidth = (gameBox.width as number) - 2;
  const gameHeight = (gameBox.height as number) - 4;
  if (gameWidth > 4 && gameHeight > 4) {
    game.resize(Math.min(30, gameWidth), Math.min(12, gameHeight));
  }

  const header = `Game ${status} | Focus: ${focus} | ${hookLine} | Score: ${game.score}`;
  const controls = "Move: arrows/WASD  Toggle focus: Ctrl+G  Quit: Ctrl+Q";
  const grid = game.render();
  const content = [header, controls, ...grid].join("\n");
  gameBox.setContent(content);

  screen.render();
}

function refreshHookState() {
  const { state, mtime } = readHookState(args.stateFile, hookMtime);
  if (mtime !== null && mtime !== hookMtime) {
    hookState = state;
    hookMtime = mtime;
  } else if (mtime === null) {
    hookState = "unknown";
    hookMtime = null;
  }
}

screen.on("resize", render);

screen.key(["C-q"], () => {
  ptyProcess.kill();
  screen.destroy();
  process.exit(0);
});

screen.key(["C-g"], () => {
  manualFocus = manualFocus === "game" ? "copilot" : manualFocus === "copilot" ? null : "game";
  render();
});

screen.on("keypress", (ch, key) => {
  const waiting = promptDetected || hookState === "idle";
  const focus: Focus = manualFocus ?? (waiting ? "copilot" : "game");
  if (focus === "game") {
    if (key.name === "up" || ch === "w" || ch === "W") {
      game.move(0, -1);
    } else if (key.name === "down" || ch === "s" || ch === "S") {
      game.move(0, 1);
    } else if (key.name === "left" || ch === "a" || ch === "A") {
      game.move(-1, 0);
    } else if (key.name === "right" || ch === "d" || ch === "D") {
      game.move(1, 0);
    } else if (ch === "r" || ch === "R") {
      game.reset();
    } else {
      return;
    }
    render();
    return;
  }
  sendToCopilot(ptyProcess, key, ch ?? undefined);
});

refreshHookState();
render();
setInterval(() => {
  refreshHookState();
  render();
}, 200);
