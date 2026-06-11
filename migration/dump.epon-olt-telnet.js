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

const sanitizeFileToken = (value) =>
  String(value || "")
    .trim()
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);

const stripTelnetNegotiation = (buffer) => {
  const output = [];

  for (let index = 0; index < buffer.length; index += 1) {
    const byte = buffer[index];

    if (byte === 255) {
      const command = buffer[index + 1];
      if ([251, 252, 253, 254].includes(command)) {
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }

    output.push(byte);
  }

  return Buffer.from(output).toString("utf8");
};

const normalizeMac = (value) => {
  const hex = String(value || "").replace(/[^a-f0-9]/gi, "").toUpperCase();
  if (hex.length !== 12) return value;
  return hex.match(/.{2}/g).join(":");
};

const normalizeOutput = (value) =>
  String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/\b[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}\b/gi, normalizeMac)
    .replace(/\b[0-9a-f]{2}(?:[:-][0-9a-f]{2}){5}\b/gi, normalizeMac);

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

      if (patterns.some((pattern) => pattern.test(this.buffer))) {
        return this.buffer;
      }

      await sleep(120);
    }

    throw new Error(`Timed out waiting for ${label}. Last output: ${this.buffer.slice(-500)}`);
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

  clearBuffer() {
    this.buffer = "";
    this.morePromptCount = 0;
  }

  async runCommand(command) {
    this.clearBuffer();
    this.writeLine(command);
    const output = await this.waitFor([this.promptRegex], `prompt after "${command}"`);
    return normalizeOutput(output);
  }

  close() {
    if (this.socket) {
      this.socket.end();
      this.socket.destroy();
    }
  }
}

const normalizeEponPort = (value) => {
  const trimmed = String(value || "").trim();
  const match = trimmed.match(/^epon-(?:olt|onu)_(\d+\/\d+\/\d+)(?::\d+)?$/i);
  return match ? `epon-olt_${match[1]}` : trimmed;
};

const getEponPorts = () =>
  String(process.env.OLT_EPON_PORTS || process.env.OLT_BASEINFO_PORTS || "")
    .split(",")
    .map(normalizeEponPort)
    .filter((item) => /^epon-olt_/i.test(item));

const main = async () => {
  const host = getArg("host", process.env.OLT_HOST || "");
  const port = Number(getArg("port", process.env.OLT_PORT || "23"));
  const username = getArg("user", process.env.OLT_USER || process.env.OLT_USERNAME || "");
  const password = getArg("password", process.env.OLT_PASSWORD || "");
  const enablePassword = getArg("enable-password", process.env.OLT_ENABLE_PASSWORD || "");
  const promptPattern = getArg("prompt", process.env.OLT_PROMPT_REGEX || "[>#]\\s*$");
  const timeoutMs = Number(getArg("timeout-ms", process.env.OLT_TIMEOUT_MS || "60000"));
  const outputDir = path.resolve(getArg("output", process.env.OLT_DUMP_OUTPUT || path.join(__dirname, "olt-dumps")));
  const macCommand = getArg("mac-command", process.env.OLT_EPON_SHOW_MAC_COMMAND || process.env.OLT_SHOW_MAC_COMMAND || "show mac");
  const setupCommand = getArg("setup-command", process.env.OLT_SETUP_COMMAND || "terminal length 0");
  const stateTemplate = getArg("state-template", process.env.OLT_EPON_STATE_COMMAND_TEMPLATE || "show epon onu state {port}");
  const eponPorts = getArg("ports", "").trim()
    ? getArg("ports").split(",").map(normalizeEponPort).filter((item) => /^epon-olt_/i.test(item))
    : getEponPorts();

  if (hasArg("help") || !host || !username || !password || eponPorts.length === 0) {
    console.log("Usage:");
    console.log("  node migration/dump.epon-olt-telnet.js --ports=epon-olt_1/4/1,epon-olt_1/4/2");
    console.log("");
    console.log("Current env values:");
    console.log(`  OLT_HOST=${host || "(empty)"}`);
    console.log(`  OLT_USER=${username || "(empty)"}`);
    console.log(`  OLT_PASSWORD=${password ? "(set)" : "(empty)"}`);
    console.log(`  OLT_EPON_PORTS=${process.env.OLT_EPON_PORTS || "(empty)"}`);
    console.log("");
    console.log("Required env:");
    console.log("  OLT_HOST, OLT_USER, OLT_PASSWORD, OLT_EPON_PORTS");
    console.log("");
    console.log("Optional env:");
    console.log("  OLT_PORT, OLT_TIMEOUT_MS, OLT_EPON_SHOW_MAC_COMMAND, OLT_EPON_STATE_COMMAND_TEMPLATE");
    return;
  }

  fs.mkdirSync(outputDir, { recursive: true });

  const session = new TelnetSession({
    host,
    port,
    timeoutMs,
    promptRegex: new RegExp(promptPattern)
  });

  console.log(`Connecting to EPON OLT ${host}:${port}...`);
  console.log(`Saving EPON dumps to ${outputDir}`);

  try {
    await session.connect();
    await session.login({ username, password, enablePassword });

    if (setupCommand) {
      try {
        await session.runCommand(setupCommand);
      } catch (error) {
        console.log(`Setup command ignored: ${error.message}`);
      }
    }

    console.log(`Running: ${macCommand}`);
    const macOutput = await session.runCommand(macCommand);
    fs.writeFileSync(path.join(outputDir, "show-epon-mac.txt"), macOutput, "utf8");

    for (const portName of eponPorts) {
      const command = stateTemplate.replace(/\{port\}/gi, portName);
      console.log(`Running: ${command}`);
      const output = await session.runCommand(command);
      const fileName = `${sanitizeFileToken(command) || "show-epon-onu-state"}.txt`;
      fs.writeFileSync(path.join(outputDir, fileName), output, "utf8");
    }

    console.log("EPON OLT dump finished.");
  } finally {
    session.close();
  }
};

main().catch((error) => {
  console.error("EPON OLT TELNET DUMP ERROR:", error.message);
  process.exitCode = 1;
});
