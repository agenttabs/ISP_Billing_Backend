require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const fs = require("fs");
const net = require("net");
const path = require("path");

const args = process.argv.slice(2);

const getArg = (name, fallback = "") => {
  const prefix = `--${name}=`;
  const found = args.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
};

const hasArg = (name) => args.includes(`--${name}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const csvPath = path.resolve(
  getArg(
    "csv",
    process.env.OLT_MATCH_CSV ||
      path.join(__dirname, "olt-dumps", "mikrotik-ppp-active-olt-authinfo.csv")
  )
);

const stripTelnetNegotiation = (buffer) => {
  const output = [];

  for (let i = 0; i < buffer.length; i += 1) {
    const byte = buffer[i];

    if (byte === 255) {
      const command = buffer[i + 1];
      if ([251, 252, 253, 254].includes(command)) {
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    output.push(byte);
  }

  return Buffer.from(output).toString("utf8");
};

const parseCsvLine = (line) => {
  const values = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      i += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      values.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  values.push(current);
  return values;
};

const readCsv = (filePath) => {
  const lines = fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim());

  if (lines.length < 2) {
    return [];
  }

  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return headers.reduce((row, header, index) => {
      row[header] = values[index] || "";
      return row;
    }, {});
  });
};

const sanitizeClientName = (value) =>
  String(value || "")
    .trim()
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

const buildTemplateValues = (row) => {
  const oltPort = String(row.OLTPort || "").trim();
  const portMatch = oltPort.match(/^(gpon-onu_(\d+)\/(\d+)\/(\d+)):(\d+)$/i);
  const ponPort = portMatch ? `gpon-olt_${portMatch[2]}/${portMatch[3]}/${portMatch[4]}` : "";
  const onuId = portMatch ? portMatch[5] : "";
  const name = sanitizeClientName(row.MikroTikName);

  return {
    ...row,
    name,
    clientName: name,
    mikrotikName: row.MikroTikName || "",
    mac: row.MacAddress || "",
    ip: row.IPAddress || "",
    vlan: row.VLAN || "",
    oltPort,
    ponPort,
    onuId,
    authInfo: row.AuthInfo || ""
  };
};

const applyTemplate = (template, values) =>
  template.replace(/\{([^}]+)\}/g, (_, key) => String(values[key] ?? ""));

class TelnetSession {
  constructor({ host, port, timeoutMs, promptRegex }) {
    this.host = host;
    this.port = port;
    this.timeoutMs = timeoutMs;
    this.promptRegex = promptRegex;
    this.socket = null;
    this.buffer = "";
    this.morePromptCount = 0;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port }, () => {
        this.socket = socket;
        resolve();
      });

      socket.setTimeout(this.timeoutMs);
      socket.on("data", (chunk) => {
        this.buffer += stripTelnetNegotiation(chunk);
      });
      socket.on("timeout", () => reject(new Error("Telnet connection timed out.")));
      socket.on("error", reject);
    });
  }

  writeLine(value) {
    this.socket.write(`${value}\r\n`);
  }

  async waitFor(patterns, label) {
    const deadline = Date.now() + this.timeoutMs;

    while (Date.now() < deadline) {
      const morePrompts = this.buffer.match(/--\s*More\s*--|More\?/gi) || [];
      if (morePrompts.length > this.morePromptCount) {
        this.morePromptCount = morePrompts.length;
        this.socket.write(" ");
      }

      const matchedPattern = patterns.find((pattern) => pattern.test(this.buffer));
      if (matchedPattern) {
        return this.buffer;
      }

      await sleep(120);
    }

    throw new Error(`Timed out waiting for ${label}. Last output: ${this.buffer.slice(-500)}`);
  }

  clearBuffer() {
    this.buffer = "";
    this.morePromptCount = 0;
  }

  async login({ username, password, enablePassword }) {
    await this.waitFor(
      [/login[: ]*$/i, /username[: ]*$/i, /user name[: ]*$/i, /password[: ]*$/i, this.promptRegex],
      "login prompt"
    );

    if (/password[: ]*$/i.test(this.buffer)) {
      this.writeLine(password);
    } else if (!this.promptRegex.test(this.buffer)) {
      this.writeLine(username);
      await this.waitFor([/password[: ]*$/i], "password prompt");
      this.writeLine(password);
    }

    await this.waitFor([this.promptRegex], "OLT prompt");

    if (enablePassword) {
      this.clearBuffer();
      this.writeLine("enable");
      await this.waitFor([/password[: ]*$/i, this.promptRegex], "enable prompt");

      if (/password[: ]*$/i.test(this.buffer)) {
        this.writeLine(enablePassword);
        await this.waitFor([this.promptRegex], "privileged prompt");
      }
    }
  }

  async runCommand(command) {
    this.clearBuffer();
    this.writeLine(command);
    await this.waitFor([this.promptRegex], `prompt after "${command}"`);
  }

  close() {
    if (this.socket) {
      this.socket.end();
      this.socket.destroy();
    }
  }
}

const main = async () => {
  const host = getArg("host", process.env.OLT_HOST || "");
  const port = Number(getArg("port", process.env.OLT_PORT || "23"));
  const username = getArg("user", process.env.OLT_USER || process.env.OLT_USERNAME || "");
  const password = getArg("password", process.env.OLT_PASSWORD || "");
  const enablePassword = getArg("enable-password", process.env.OLT_ENABLE_PASSWORD || "");
  const promptPattern = getArg("prompt", process.env.OLT_PROMPT_REGEX || "[>#]\\s*$");
  const timeoutMs = Number(getArg("timeout-ms", process.env.OLT_TIMEOUT_MS || "20000"));
  const template = getArg("template", process.env.OLT_UPDATE_NAME_TEMPLATE || "");
  const limit = Number(getArg("limit", "0")) || 0;
  const isCommit = hasArg("commit");

  if (!template || hasArg("help")) {
    console.log("Usage:");
    console.log("  node migration/update.olt-client-name.js --template=\"conf t;;interface {oltPort};;name {name};;exit;;exit\" --commit");
    console.log("");
    console.log("Placeholders:");
    console.log("  {name}, {clientName}, {mikrotikName}, {oltPort}, {ponPort}, {onuId}, {authInfo}, {mac}, {ip}, {vlan}");
    console.log("");
    console.log("Without --commit this is dry-run only.");
    return;
  }

  const rows = readCsv(csvPath)
    .map(buildTemplateValues)
    .filter((row) => row.name && row.oltPort);
  const targetRows = limit > 0 ? rows.slice(0, limit) : rows;

  if (!isCommit) {
    console.log("DRY RUN ONLY. Add --commit to apply changes.");
    console.log(`Rows: ${targetRows.length}`);
    targetRows.slice(0, 10).forEach((row) => {
      const commands = template.split(";;").map((command) => applyTemplate(command, row).trim());
      console.log(`\n${row.mikrotikName} ${row.oltPort} ${row.authInfo}`);
      commands.forEach((command) => console.log(`  ${command}`));
    });
    return;
  }

  if (!host || !username || !password) {
    throw new Error("Missing OLT host/user/password. Pass args or set OLT_HOST, OLT_USER, OLT_PASSWORD.");
  }

  const session = new TelnetSession({
    host,
    port,
    timeoutMs,
    promptRegex: new RegExp(promptPattern)
  });

  console.log(`Connecting to OLT ${host}:${port}...`);
  console.log(`Updating ${targetRows.length} OLT client name(s).`);

  try {
    await session.connect();
    await session.login({ username, password, enablePassword });

    for (const row of targetRows) {
      const commands = template
        .split(";;")
        .map((command) => applyTemplate(command, row).trim())
        .filter(Boolean);

      console.log(`Updating ${row.mikrotikName} -> ${row.oltPort}`);
      for (const command of commands) {
        await session.runCommand(command);
      }
    }

    console.log("OLT client name update finished.");
  } finally {
    session.close();
  }
};

main().catch((error) => {
  console.error("OLT CLIENT NAME UPDATE ERROR:", error.message);
  process.exitCode = 1;
});
