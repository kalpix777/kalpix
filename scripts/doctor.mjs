// Kalpix environment inspection. Read-only: installs nothing, changes nothing.
// Usage: pnpm doctor   (or: node scripts/doctor.mjs)
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statfsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const run = (cmd) => {
  try {
    return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"], timeout: 15000 })
      .toString()
      .trim();
  } catch {
    return null;
  }
};
const gb = (b) => (b / 1024 ** 3).toFixed(1);
const results = [];
const add = (area, item, status, detail = "") => results.push({ area, item, status, detail });

// A. Hardware and OS
const memGb = os.totalmem() / 1024 ** 3;
const cpus = os.cpus();
add("Hardware", "OS", "info", `${os.type()} ${os.release()} (${os.platform()}/${os.arch()})`);
add("Hardware", "CPU", "info", `${cpus[0]?.model ?? "unknown"} x${cpus.length}`);
add(
  "Hardware",
  "RAM",
  memGb >= 8 ? "ok" : "warn",
  `${memGb.toFixed(1)} GB total, ${gb(os.freemem())} GB free`,
);
try {
  const fs = statfsSync(process.cwd());
  const freeGb = (fs.bavail * fs.bsize) / 1024 ** 3;
  add(
    "Hardware",
    "Free disk",
    freeGb >= 20 ? "ok" : "warn",
    `${freeGb.toFixed(1)} GB free on project drive`,
  );
} catch {
  add("Hardware", "Free disk", "warn", "could not read");
}
const gpu =
  run("nvidia-smi --query-gpu=name,memory.total --format=csv,noheader") ??
  (os.platform() === "darwin" ? run("sysctl -n machdep.cpu.brand_string") : null);
add(
  "Hardware",
  "GPU",
  gpu ? "info" : "warn",
  gpu ?? "No NVIDIA GPU detected (Apple Silicon reports CPU name)",
);
const localAi =
  memGb >= 32
    ? "7B-14B local models practical via Ollama"
    : memGb >= 16
      ? "Small (3B-8B quantized) local models only; use hosted APIs for quality work"
      : "Local LLMs not recommended; use hosted API free tiers";
add("Hardware", "Local AI verdict", "info", localAi);

// B. Node and package manager
const nodeMajor = Number(process.versions.node.split(".")[0]);
add(
  "Runtime",
  "Node.js",
  nodeMajor >= 22 ? "ok" : "fail",
  `v${process.versions.node} (need 22 LTS+)`,
);
const pnpm = run("pnpm -v");
add(
  "Runtime",
  "pnpm",
  pnpm ? "ok" : "fail",
  pnpm ?? "missing: run `corepack enable` then `corepack prepare pnpm@latest --activate`",
);
add("Runtime", "npm", run("npm -v") ? "ok" : "warn", run("npm -v") ?? "missing");

// C. Antigravity and MCP (best effort: config locations vary by version)
const home = os.homedir();
const agBin = run(os.platform() === "win32" ? "where antigravity" : "command -v antigravity");
add(
  "IDE",
  "Antigravity CLI",
  agBin ? "ok" : "warn",
  agBin ?? "not on PATH (IDE may still be installed; confirm manually)",
);
const mcpCandidates = [
  path.join(home, ".gemini", "antigravity", "mcp_config.json"),
  path.join(home, ".gemini", "settings.json"),
  path.join(home, ".antigravity", "mcp.json"),
  path.join(home, ".cursor", "mcp.json"),
  path.join(home, ".vscode", "mcp.json"),
  path.join(process.cwd(), ".vscode", "mcp.json"),
];
let mcpFound = false;
for (const file of mcpCandidates) {
  if (!existsSync(file)) continue;
  try {
    const json = JSON.parse(readFileSync(file, "utf8"));
    const servers = Object.keys(json.mcpServers ?? json.servers ?? {});
    mcpFound = true;
    const rea = servers.filter((s) => /rea/i.test(s));
    add(
      "IDE",
      `MCP config ${file}`,
      rea.length ? "ok" : "info",
      `servers: ${servers.join(", ") || "none"}${rea.length ? ` | REA match: ${rea.join(", ")}` : " | no REA-named server"}`,
    );
  } catch {
    add("IDE", `MCP config ${file}`, "warn", "exists but is not valid JSON");
  }
}
if (!mcpFound)
  add(
    "IDE",
    "REA MCP",
    "warn",
    "no MCP config found in known locations; confirm inside Antigravity > MCP settings",
  );

// D. Git and GitHub
const git = run("git --version");
add("Source control", "Git", git ? "ok" : "fail", git ?? "missing");
const gitUser = run("git config --global user.email");
add(
  "Source control",
  "Git identity",
  gitUser ? "ok" : "warn",
  gitUser ?? "set: git config --global user.name/user.email",
);
const gh = run("gh --version");
add(
  "Source control",
  "GitHub CLI",
  gh ? "ok" : "warn",
  gh ? gh.split("\n")[0] : "optional: https://cli.github.com",
);
if (gh)
  add(
    "Source control",
    "GitHub auth",
    run("gh auth status") !== null ? "ok" : "warn",
    "run `gh auth login` if not authenticated",
  );

// E. Docker
const docker = run("docker --version");
add(
  "Containers",
  "Docker",
  docker ? "ok" : "warn",
  docker ?? "missing: install Docker Desktop (free for small businesses; check licence)",
);
if (docker) {
  const info = run("docker info --format '{{.ServerVersion}}'");
  add(
    "Containers",
    "Docker daemon",
    info ? "ok" : "warn",
    info ? `running (server ${info})` : "installed but not running",
  );
  add(
    "Containers",
    "Docker Compose",
    run("docker compose version") ? "ok" : "warn",
    run("docker compose version") ?? "missing",
  );
}

// F. PostgreSQL
const psql = run("psql --version");
add(
  "Database",
  "psql client",
  psql ? "ok" : "info",
  psql ?? "not installed (fine if using Docker Postgres)",
);
add(
  "Database",
  ".env present",
  existsSync(".env") ? "ok" : "warn",
  existsSync(".env") ? "" : "copy .env.example to .env",
);

// Optional local AI
const ollama = run("ollama --version");
add(
  "Optional",
  "Ollama",
  ollama ? "ok" : "info",
  ollama ?? "not installed (only needed for local models)",
);

// Report
const icon = { ok: "PASS", warn: "WARN", fail: "FAIL", info: "INFO" };
const lines = [
  "# Kalpix Environment Report",
  "",
  `Generated: ${new Date().toISOString()}`,
  "",
  "| Area | Check | Status | Detail |",
  "|---|---|---|---|",
  ...results.map(
    (r) => `| ${r.area} | ${r.item} | ${icon[r.status]} | ${r.detail.replace(/\|/g, "/")} |`,
  ),
  "",
];
mkdirSync("reports", { recursive: true });
writeFileSync("reports/environment-report.md", lines.join("\n"));
for (const r of results) console.log(`[${icon[r.status]}] ${r.area} / ${r.item}: ${r.detail}`);
const fails = results.filter((r) => r.status === "fail").length;
console.log(`\nReport written to reports/environment-report.md (${fails} blocking issue(s)).`);
process.exit(fails ? 1 : 0);
