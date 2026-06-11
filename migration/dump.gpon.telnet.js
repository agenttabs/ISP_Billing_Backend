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

const normalizeOutput = (value) =>
  String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");

const formatMacAddress = (value) => {
  const hex = String(value || "").replace(/[^a-f0-9]/gi, "").toUpperCase();
  if (hex.length !== 12) {
    return value;
  }

  return hex.match(/.{2}/g).join(":");
};

const normalizeMacAddresses = (value) =>
  String(value || "")
    .replace(/\b[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}\b/gi, (match) =>
      formatMacAddress(match)
    )
    .replace(/\b[0-9a-f]{2}(?:[:-][0-9a-f]{2}){5}\b/gi, (match) =>
      formatMacAddress(match)
    );

const normalizeGponPort = (value) => {
  const trimmed = String(value || "").trim();
  const match = trimmed.match(/^gpon-(?:olt|onu)_(\d+\/\d+\/\d+)(?::\d+)?$/i);
  return match ? `gpon-olt_${match[1]}` : trimmed;
};

const getGponPorts = () =>
  String(process.env.OLT_GPON_PORTS || process.env.OLT_BASEINFO_PORTS || "")
    .split(",")
    .map(normalizeGponPort)
    .filter((item) => /^gpon-olt_/i.test(item));

const getGponPortConfigSource = () =>
  String(process.env.OLT_GPON_PORTS || "").trim() ? "OLT_GPON_PORTS" : "OLT_BASEINFO_PORTS";

class TelnetSession {
  constructor({ host, port, timeoutMs, promptRegex }) {
    this.host = host;
    this.port = port;
    this.timeoutMs = timeoutMs;
    this.promptRegex = promptRegex;
    this.socket = null;
    this.buffer = "";
    this.fullLog = "";
    this.morePromptCount = 0;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(
        {
          host: this.host,
          port: this.port
        },
        () => {
          this.socket = socket;
          resolve();
        }
      );

      socket.setTimeout(this.timeoutMs);
      socket.on("data", (chunk) => {
        const text = stripTelnetNegotiation(chunk);
        this.buffer += text;
        this.fullLog += text;
      });
      socket.on("timeout", () => reject(new Error("Telnet connection timed out.")));
      socket.on("error", reject);
    });
  }

  writeLine(value) {
    this.socket.write(`${value}\r\n`);
    this.fullLog += `\n>>> ${value}\n`;
  }

  async waitFor(patterns, label) {
    const deadline = Date.now() + this.timeoutMs;

    while (Date.now() < deadline) {
      const morePrompts = this.buffer.match(/--\s*More\s*--|More\?/gi) || [];
      if (morePrompts.length > this.morePromptCount) {
        this.morePromptCount = morePrompts.length;
        this.socket.write(" ");
        this.fullLog += "\n>>> [space for more]\n";
      }

      const matchedPattern = patterns.find((pattern) => pattern.test(this.buffer));
      if (matchedPattern) {
        return {
          pattern: matchedPattern,
          text: this.buffer
        };
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
    const result = await this.waitFor([this.promptRegex], `prompt after "${command}"`);
    return normalizeMacAddresses(normalizeOutput(result.text));
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
  const timeoutMs = Number(getArg("timeout-ms", process.env.OLT_TIMEOUT_MS || "60000"));
  const outputRoot = path.resolve(
    getArg("output", process.env.OLT_DUMP_OUTPUT || path.join(__dirname, "olt-dumps"))
  );
  const setupCommand = getArg("setup-command", process.env.OLT_SETUP_COMMAND || "terminal length 0");
  const macCommand = getArg("mac-command", process.env.OLT_GPON_SHOW_MAC_COMMAND || process.env.OLT_SHOW_MAC_COMMAND || "show mac");
  const baseInfoTemplate = getArg("baseinfo-template", process.env.OLT_GPON_BASEINFO_COMMAND_TEMPLATE || "show gpon onu baseinfo {port}");
  const gponPorts = getArg("ports", "").trim()
    ? getArg("ports").split(",").map(normalizeGponPort).filter((item) => /^gpon-olt_/i.test(item))
    : getGponPorts();

  if (hasArg("help") || !host || !username || !password || gponPorts.length === 0) {
    console.log("Usage:");
    console.log("  node migration/dump.gpon.telnet.js");
    console.log("");
    console.log("Current env values:");
    console.log(`  OLT_HOST=${host || "(empty)"}`);
    console.log(`  OLT_USER=${username || "(empty)"}`);
    console.log(`  OLT_PASSWORD=${password ? "(set)" : "(empty)"}`);
    console.log(`  OLT_GPON_PORTS=${process.env.OLT_GPON_PORTS || "(empty)"}`);
    console.log(`  OLT_BASEINFO_PORTS=${process.env.OLT_BASEINFO_PORTS || "(empty)"}`);
    console.log("");
    console.log("Required env:");
    console.log("  OLT_HOST, OLT_USER, OLT_PASSWORD, OLT_BASEINFO_PORTS");
    console.log("");
    console.log("Optional env:");
    console.log("  OLT_PORT, OLT_TIMEOUT_MS, OLT_GPON_PORTS, OLT_GPON_SHOW_MAC_COMMAND, OLT_GPON_BASEINFO_COMMAND_TEMPLATE");
    return;
  }

  const outputDir = outputRoot;
  fs.mkdirSync(outputDir, { recursive: true });

  const session = new TelnetSession({
    host,
    port,
    timeoutMs,
    promptRegex: new RegExp(promptPattern)
  });

  console.log(`Connecting to GPON OLT ${host}:${port}...`);
  console.log(`Saving GPON dumps to ${outputDir}`);
  console.log(`Using GPON ports from ${getGponPortConfigSource()}: ${gponPorts.join(", ")}`);

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
    fs.writeFileSync(path.join(outputDir, "show-mac.txt"), macOutput, "utf8");

    for (const portName of gponPorts) {
      const command = baseInfoTemplate.replace(/\{port\}/gi, portName);
      console.log(`Running: ${command}`);
      const output = await session.runCommand(command);
      const fileName = `${sanitizeFileToken(command) || "command-output"}.txt`;
      const filePath = path.join(outputDir, fileName);
      fs.writeFileSync(filePath, output, "utf8");
    }

    console.log("GPON OLT dump finished.");
  } finally {
    session.close();
  }
};

main().catch((error) => {
  console.error("GPON OLT TELNET DUMP ERROR:", error.message);
  process.exitCode = 1;
});
