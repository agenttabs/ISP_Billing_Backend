const fs = require("fs");
const net = require("net");
const path = require("path");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

const normalizeOutput = (value) =>
  String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/--\s*More\s*--/gi, "")
    .replace(/[\b\u0008]/g, "");

const normalizeMac = (value) => {
  const hex = String(value || "").replace(/[^a-f0-9]/gi, "").toUpperCase();
  if (hex.length !== 12) return "";
  return hex.match(/.{2}/g).join(":");
};

const getMacMatchKey = (value) => {
  const hex = String(value || "").replace(/[^a-f0-9]/gi, "").toUpperCase();
  return hex.length === 12 ? hex.slice(0, -2) : "";
};

const normalizeMacAddresses = (value) =>
  String(value || "")
    .replace(/\b[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}\b/gi, (match) =>
      normalizeMac(match)
    )
    .replace(/\b[0-9a-f]{2}(?:[:-][0-9a-f]{2}){5}\b/gi, (match) =>
      normalizeMac(match)
    );

const normalizeSn = (value) =>
  String(value || "")
    .trim()
    .replace(/^SN:/i, "")
    .replace(/[^a-z0-9]/gi, "")
    .toUpperCase();

const normalizePonPort = (value) => {
  const trimmed = String(value || "").trim();
  const match = trimmed.match(/^((?:gpon|epon))-(?:olt|onu)_(\d+\/\d+\/\d+)(?::\d+)?$/i);
  return match ? `${match[1].toLowerCase()}-olt_${match[2]}` : trimmed;
};

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
    return normalizeMacAddresses(normalizeOutput(output));
  }

  close() {
    if (this.socket) {
      this.socket.end();
      this.socket.destroy();
    }
  }
}

const getOltConfig = () => {
  const baseInfoPorts = String(
    process.env.OLT_BASEINFO_PORTS || "gpon-olt_1/3/2,gpon-olt_1/3/3"
  )
    .split(",")
    .map(normalizePonPort)
    .filter(Boolean);
  const eponPorts = String(process.env.OLT_EPON_PORTS || "")
    .split(",")
    .map(normalizePonPort)
    .filter(Boolean);
  const allPorts = [...new Set([...baseInfoPorts, ...eponPorts])];

  return {
    host: String(process.env.OLT_HOST || "").trim(),
    port: Number(process.env.OLT_PORT || 23),
    username: String(process.env.OLT_USER || process.env.OLT_USERNAME || "").trim(),
    password: String(process.env.OLT_PASSWORD || ""),
    enablePassword: String(process.env.OLT_ENABLE_PASSWORD || ""),
    promptRegex: new RegExp(process.env.OLT_PROMPT_REGEX || "[>#]\\s*$"),
    timeoutMs: Number(process.env.OLT_TIMEOUT_MS || 60000),
    macCommand: String(process.env.OLT_SHOW_MAC_COMMAND || "show mac").trim(),
    baseInfoCommandTemplate: String(process.env.OLT_BASEINFO_COMMAND_TEMPLATE || "").trim(),
    fiberCommandTemplate: String(
      process.env.OLT_FIBER_COMMAND_TEMPLATE ||
        process.env.OLT_OPTICAL_COMMAND_TEMPLATE ||
        "show pon power attenuation {onu}"
    ).trim(),
    gponFiberCommandTemplate: String(
      process.env.OLT_GPON_FIBER_COMMAND_TEMPLATE ||
        process.env.OLT_GPON_OPTICAL_COMMAND_TEMPLATE ||
        process.env.OLT_FIBER_COMMAND_TEMPLATE ||
        process.env.OLT_OPTICAL_COMMAND_TEMPLATE ||
        "show pon power attenuation {onu}"
    ).trim(),
    eponFiberCommandTemplate: String(
      process.env.OLT_EPON_FIBER_COMMAND_TEMPLATE ||
        process.env.OLT_EPON_OPTICAL_COMMAND_TEMPLATE ||
        process.env.OLT_FIBER_COMMAND_TEMPLATE ||
        process.env.OLT_OPTICAL_COMMAND_TEMPLATE ||
        "show pon power attenuation {onu}"
    ).trim(),
    baseInfoPorts: allPorts
  };
};

const parseMacRows = (text) => {
  const rows = [];
  const regex =
    /([0-9a-f]{2}(?::[0-9a-f]{2}){5}|[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4})\s+(\d+)\s+(\S+)\s+((?:gpon|epon)-onu_\d+\/\d+\/\d+:\d+)\s+([^\n]*)/gi;

  let match;
  while ((match = regex.exec(text)) !== null) {
    const macAddress = normalizeMac(match[1]);
    if (!macAddress) continue;

    rows.push({
      macAddress,
      vlan: String(match[2] || "").trim(),
      type: String(match[3] || "").trim(),
      oltPort: String(match[4] || "").trim(),
      vc: String(match[5] || "").trim()
    });
  }

  return rows;
};

const parseOnuRows = (text, sourceCommand) => {
  const rows = [];
  const regex =
    /((?:gpon|epon)-onu_\d+\/\d+\/\d+:\d+)\s+(\S+)\s+(\S+)\s+(SN:\S+)\s+(\S+)/gi;

  let match;
  while ((match = regex.exec(text)) !== null) {
    rows.push({
      oltPort: String(match[1] || "").trim(),
      onuType: String(match[2] || "").trim(),
      mode: String(match[3] || "").trim(),
      authInfo: normalizeSn(match[4]),
      onuState: String(match[5] || "").trim(),
      sourceCommand
    });
  }

  if (/show\s+epon\s+onu\s+state/i.test(sourceCommand)) {
    for (const line of String(text || "").split("\n")) {
      const stateMatch = line.match(
        /\b(epon-onu_\d+\/\d+\/\d+:\d+)\b\s+(\S+)\s+(\S+)\s+([0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}|[0-9a-f]{2}(?::[0-9a-f]{2}){5})/i
      );
      if (!stateMatch) continue;

      const oltPort = String(stateMatch[1] || "").trim();
      if (rows.some((row) => row.oltPort === oltPort)) continue;

      const onlineStatus = String(stateMatch[2] || "").trim();
      const oamStatus = String(stateMatch[3] || "").trim();
      rows.push({
        oltPort,
        macAddress: normalizeMac(stateMatch[4]),
        onuType: "",
        mode: "",
        authInfo: "",
        onuState: `${onlineStatus} / ${oamStatus}`,
        onlineStatus,
        oamStatus,
        sourceCommand
      });
    }
  }

  return rows;
};

const toPonPort = (onuPort) => {
  const match = String(onuPort || "").match(/^((?:gpon|epon))-onu_(\d+\/\d+\/\d+):\d+$/i);
  return match ? `${match[1].toLowerCase()}-olt_${match[2]}` : "";
};

const buildBaseInfoCommand = (port, template) => {
  const type = String(port || "").toLowerCase().startsWith("epon-olt") ? "epon" : "gpon";
  const commandTemplate =
    template ||
    (type === "epon" ? "show epon onu state {port}" : "show gpon onu baseinfo {port}");
  return commandTemplate
    .replace(/\{type\}/gi, type)
    .replace(/\{port\}/gi, port);
};

const buildFiberCommand = (onuPort, template) => {
  if (!onuPort || !template) return "";
  return template
    .replace(/\{onu\}/gi, onuPort)
    .replace(/\{port\}/gi, onuPort);
};

const getFiberCommandTemplate = (config, typeOrPort) => {
  const normalized = String(typeOrPort || "").trim().toUpperCase();
  if (normalized === "EPON" || normalized.startsWith("EPON-ONU")) {
    return config.eponFiberCommandTemplate || config.fiberCommandTemplate;
  }

  if (normalized === "GPON" || normalized.startsWith("GPON-ONU")) {
    return config.gponFiberCommandTemplate || config.fiberCommandTemplate;
  }

  return config.fiberCommandTemplate;
};

const buildLiveCommand = ({ template, onuPort, authInfo }) => {
  if (!template || !onuPort) return "";
  const ponPort = toPonPort(onuPort);
  return template
    .replace(/\{onu\}/gi, onuPort)
    .replace(/\{port\}/gi, onuPort)
    .replace(/\{pon\}/gi, ponPort)
    .replace(/\{sn\}/gi, authInfo || "");
};

const parseFiberReading = (text) => {
  const clean = String(text || "");
  const rxMatches = [...clean.matchAll(/\bRx\s*:?\s*(-?\d+(?:\.\d+)?)\s*\(?\s*dBm\s*\)?/gi)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value) && Math.abs(value) < 100);
  const dbmMatches = rxMatches.length
    ? rxMatches
    : [...clean.matchAll(/(-?\d+(?:\.\d+)?)\s*\(?\s*dBm\s*\)?/gi)]
        .map((match) => Number(match[1]))
        .filter((value) => Number.isFinite(value) && Math.abs(value) < 100);
  const uniqueReadings = [...new Set(dbmMatches.map((value) => Number(value.toFixed(3))))];
  const fiberRead = uniqueReadings.length
    ? uniqueReadings.map((value) => `${value} dBm`).join(" / ")
    : "";
  const lower = clean.toLowerCase();
  let fiberStatus = "";

  if (/offline|los|loss|fail|abnormal/.test(lower)) {
    fiberStatus = "BAD";
  } else if (uniqueReadings.length) {
    const hasGoodReading = uniqueReadings.some((reading) => reading >= -27 && reading <= -8);
    fiberStatus = hasGoodReading ? "OK" : "CHECK";
  } else if (/online|working|normal|complete|ok|ready/.test(lower)) {
    fiberStatus = "OK";
  }

  return {
    fiberRead,
    fiberStatus,
    rawFiberOutput: clean.trim()
  };
};

const parseLiveOnuStatus = (text, onuPort, fallbackStatus = "") => {
  const clean = String(text || "").trim();
  const line = clean
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item.toLowerCase().includes(String(onuPort || "").toLowerCase()));

  if (!line) {
    return fallbackStatus;
  }

  if (/offline|los|down|disable|disabled|fail/i.test(line)) {
    return "offline";
  }

  if (/online|ready|working|up|enable|enabled|ok|o5|o7/i.test(line)) {
    return "online";
  }

  const fields = line.split(/\s+/).filter(Boolean);
  return fields.slice(1).join(" ") || fallbackStatus;
};

const parseFiberLength = (text) => {
  const clean = String(text || "");
  const kmMatch = clean.match(/(\d+(?:\.\d+)?)\s*km\b/i);
  if (kmMatch) return `${kmMatch[1]} km`;

  const meterMatch = clean.match(/(\d+(?:\.\d+)?)\s*(?:m|meter|meters)\b/i);
  if (meterMatch) return `${meterMatch[1]} m`;

  const distanceLine = clean
    .split("\n")
    .map((line) => line.trim())
    .find((line) => /distance|length/i.test(line));

  return distanceLine || "";
};

const runLiveOnuDetails = async ({ onuPort, authInfo, type }) => {
  const config = getOltConfig();

  if (!config.host || !config.username || !config.password || !onuPort) {
    return {
      status: "",
      fiberRead: "",
      fiberStatus: "",
      fiberLength: "",
      commandsRun: [],
      error: !onuPort ? "No OLT ONU port found for live detail check." : ""
    };
  }

  const normalizedType = String(type || "").trim().toUpperCase();
  const statusTemplate = String(
    normalizedType === "GPON"
      ? process.env.OLT_GPON_STATUS_COMMAND_TEMPLATE || "show gpon onu state {pon}"
      : process.env.OLT_EPON_STATUS_COMMAND_TEMPLATE || "show epon onu state {pon}"
  ).trim();
  const lengthTemplate = String(
    normalizedType === "GPON"
      ? process.env.OLT_GPON_LENGTH_COMMAND_TEMPLATE || "show pon onu distance {onu}"
      : process.env.OLT_EPON_LENGTH_COMMAND_TEMPLATE || ""
  ).trim();

  const session = new TelnetSession(config);
  const commandsRun = [];

  try {
    await session.connect();
    await session.login({
      username: config.username,
      password: config.password,
      enablePassword: config.enablePassword
    });

    const setupCommand = String(process.env.OLT_SETUP_COMMAND || "terminal length 0").trim();
    if (setupCommand) {
      try {
        await session.runCommand(setupCommand);
        commandsRun.push(setupCommand);
      } catch (_) {
        commandsRun.push(`${setupCommand} (ignored)`);
      }
    }

    let liveStatus = "";
    const statusCommand = buildLiveCommand({ template: statusTemplate, onuPort, authInfo });
    if (statusCommand) {
      const statusOutput = await session.runCommand(statusCommand);
      commandsRun.push(statusCommand);
      liveStatus = parseLiveOnuStatus(statusOutput, onuPort);
    }

    let fiber = {
      fiberRead: "",
      fiberStatus: "",
      rawFiberOutput: ""
    };
    const fiberCommand = buildFiberCommand(
      onuPort,
      getFiberCommandTemplate(config, normalizedType || onuPort)
    );
    if (fiberCommand) {
      const fiberOutput = await session.runCommand(fiberCommand);
      commandsRun.push(fiberCommand);
      fiber = parseFiberReading(fiberOutput);
    }

    let fiberLength = "";
    const lengthCommand = buildLiveCommand({ template: lengthTemplate, onuPort, authInfo });
    if (lengthCommand) {
      const lengthOutput = await session.runCommand(lengthCommand);
      commandsRun.push(lengthCommand);
      fiberLength = parseFiberLength(lengthOutput);
    }

    return {
      status: liveStatus,
      fiberRead: fiber.fiberRead,
      fiberStatus: fiber.fiberStatus,
      fiberLength,
      fiberCommand,
      commandsRun,
      error: ""
    };
  } catch (error) {
    return {
      status: "",
      fiberRead: "",
      fiberStatus: "CHECK FAILED",
      fiberLength: "",
      fiberCommand: "",
      commandsRun,
      error: error.message
    };
  } finally {
    session.close();
  }
};

const findMacMatch = (rows, macAddress) => {
  const normalizedMac = normalizeMac(macAddress);
  const macMatchKey = getMacMatchKey(normalizedMac);
  if (!normalizedMac) return null;

  return (
    rows.find((row) => row.macAddress === normalizedMac && row.vlan === "100") ||
    rows.find((row) => getMacMatchKey(row.macAddress) === macMatchKey && row.vlan === "100") ||
    rows.find((row) => row.macAddress === normalizedMac) ||
    rows.find((row) => getMacMatchKey(row.macAddress) === macMatchKey) ||
    null
  );
};

const getDumpDir = () =>
  path.resolve(process.env.OLT_DUMP_DIR || path.join(__dirname, "..", "migration", "olt-dumps"));

const readDumpFile = (filePath) => {
  if (!fs.existsSync(filePath)) return "";
  return fs.readFileSync(filePath, "utf8");
};

const findGponBaseInfoFromDumps = (dumpDir, oltPort) => {
  if (!oltPort || !fs.existsSync(dumpDir)) return null;

  const files = fs
    .readdirSync(dumpDir)
    .filter((file) => /^show-gpon-onu-baseinfo-.*\.txt$/i.test(file));

  for (const file of files) {
    const rows = parseOnuRows(readDumpFile(path.join(dumpDir, file)), file);
    const found = rows.find((row) => row.oltPort === oltPort);
    if (found) return found;
  }

  return null;
};

const findEponStateFromDumps = (dumpDir, macAddress) => {
  if (!macAddress || !fs.existsSync(dumpDir)) return null;

  const normalizedMac = normalizeMac(macAddress);
  const macMatchKey = getMacMatchKey(normalizedMac);
  const files = fs
    .readdirSync(dumpDir)
    .filter((file) => /^show-epon-onu-state-.*\.txt$/i.test(file));

  for (const file of files) {
    const rows = parseOnuRows(readDumpFile(path.join(dumpDir, file)), "show epon onu state");
    const found =
      rows.find((row) => row.macAddress === normalizedMac) ||
      rows.find((row) => getMacMatchKey(row.macAddress) === macMatchKey) ||
      null;

    if (found) return found;
  }

  return null;
};

const lookupOltFromDumpsByMac = (macAddress) => {
  const normalizedMac = normalizeMac(macAddress);
  if (!normalizedMac) {
    return {
      found: false,
      source: "DUMP_FILES",
      macMatch: null,
      onuMatch: null,
      type: "",
      error: "No valid MAC address for OLT dump lookup."
    };
  }

  const dumpDir = getDumpDir();
  const showMacText = readDumpFile(path.join(dumpDir, "show-mac.txt"));
  const macRows = parseMacRows(showMacText);
  const gponRows = macRows.filter((row) => /^gpon-onu_/i.test(row.oltPort));
  const gponMacMatch = findMacMatch(gponRows, normalizedMac);

  if (gponMacMatch) {
    return {
      found: true,
      source: "DUMP_FILES",
      type: "GPON",
      macMatch: gponMacMatch,
      onuMatch: findGponBaseInfoFromDumps(dumpDir, gponMacMatch.oltPort),
      error: ""
    };
  }

  const eponStateMatch = findEponStateFromDumps(dumpDir, normalizedMac);
  if (eponStateMatch) {
    return {
      found: true,
      source: "DUMP_FILES",
      type: "EPON",
      macMatch: {
        macAddress: eponStateMatch.macAddress,
        vlan: "",
        type: "EPON_STATE",
        oltPort: eponStateMatch.oltPort,
        vc: ""
      },
      onuMatch: eponStateMatch,
      error: ""
    };
  }

  return {
    found: false,
    source: "DUMP_FILES",
    type: "",
    macMatch: null,
    onuMatch: null,
    error: "MAC was not found in GPON or EPON dump files."
  };
};

const runLiveOltLookup = async ({ macAddress, authInfo, technology }) => {
  const config = getOltConfig();

  if (!config.host || !config.username || !config.password) {
    throw new Error("Missing OLT telnet config. Set OLT_HOST, OLT_USER, and OLT_PASSWORD in backend .env.");
  }

  const session = new TelnetSession(config);
  const commandsRun = [];

  try {
    await session.connect();
    await session.login({
      username: config.username,
      password: config.password,
      enablePassword: config.enablePassword
    });

    const setupCommand = String(process.env.OLT_SETUP_COMMAND || "terminal length 0").trim();
    if (setupCommand) {
      try {
        await session.runCommand(setupCommand);
        commandsRun.push(setupCommand);
      } catch (_) {
        commandsRun.push(`${setupCommand} (ignored)`);
      }
    }

    let macRows = [];
    let onuRows = [];
    const normalizedMac = normalizeMac(macAddress);
    const normalizedSn = normalizeSn(authInfo);

    const macOutput = await session.runCommand(config.macCommand);
    commandsRun.push(config.macCommand);
    macRows = parseMacRows(macOutput);

    const normalizedMacMatchKey = getMacMatchKey(normalizedMac);
    let macMatch = normalizedMac
      ? macRows.find((row) => row.macAddress === normalizedMac && row.vlan === "100") ||
        macRows.find((row) => getMacMatchKey(row.macAddress) === normalizedMacMatchKey && row.vlan === "100") ||
        macRows.find((row) => row.macAddress === normalizedMac) ||
        macRows.find((row) => getMacMatchKey(row.macAddress) === normalizedMacMatchKey) ||
        null
      : null;

    const normalizedTechnology = String(technology || "").trim().toLowerCase();
    const configuredPorts = normalizedTechnology
      ? config.baseInfoPorts.filter((port) =>
          String(port || "").toLowerCase().startsWith(`${normalizedTechnology}-olt`)
        )
      : config.baseInfoPorts;
    const portsToScan = new Set(configuredPorts);
    if (macMatch?.oltPort) {
      const ponPort = toPonPort(macMatch.oltPort);
      if (ponPort) portsToScan.add(ponPort);
    }

    for (const port of portsToScan) {
      const command = buildBaseInfoCommand(port, config.baseInfoCommandTemplate);
      const output = await session.runCommand(command);
      commandsRun.push(command);
      onuRows = onuRows.concat(parseOnuRows(output, command));
    }

    let onuMatch = normalizedSn
      ? onuRows.find((row) => row.authInfo === normalizedSn) || null
      : null;

    if (!onuMatch && macMatch?.oltPort) {
      onuMatch = onuRows.find((row) => row.oltPort === macMatch.oltPort) || null;
    }

    if (!macMatch && onuMatch?.oltPort) {
      macMatch =
        macRows.find((row) => row.oltPort === onuMatch.oltPort && row.vlan === "100") ||
        macRows.find((row) => row.oltPort === onuMatch.oltPort) ||
        null;
    }

    if (!macMatch && normalizedMac) {
      const eponStateMatch =
        onuRows.find((row) => row.macAddress === normalizedMac) ||
        onuRows.find((row) => getMacMatchKey(row.macAddress) === normalizedMacMatchKey) ||
        null;

      if (eponStateMatch) {
        onuMatch = eponStateMatch;
        macMatch = {
          macAddress: eponStateMatch.macAddress,
          vlan: "",
          type: "EPON_STATE",
          oltPort: eponStateMatch.oltPort,
          vc: ""
        };
      }
    }

    let fiber = {
      fiberRead: "",
      fiberStatus: "",
      rawFiberOutput: "",
      fiberCommand: "",
      error: ""
    };
    const fiberOnuPort = macMatch?.oltPort || onuMatch?.oltPort || "";
    const oltType = String(fiberOnuPort).toUpperCase().startsWith("EPON-ONU")
      ? "EPON"
      : String(fiberOnuPort).toUpperCase().startsWith("GPON-ONU")
        ? "GPON"
        : "";
    const fiberCommand = buildFiberCommand(
      fiberOnuPort,
      getFiberCommandTemplate(config, oltType || fiberOnuPort)
    );
    if (fiberCommand) {
      try {
        const fiberOutput = await session.runCommand(fiberCommand);
        commandsRun.push(fiberCommand);
        fiber = {
          ...parseFiberReading(fiberOutput),
          fiberCommand,
          error: ""
        };
      } catch (error) {
        fiber = {
          fiberRead: "",
          fiberStatus: "CHECK FAILED",
          rawFiberOutput: "",
          fiberCommand,
          error: error.message
        };
      }
    }

    return {
      commandsRun,
      macRowsFound: macRows.length,
      onuRowsFound: onuRows.length,
      macMatch,
      onuMatch,
      fiber
    };
  } finally {
    session.close();
  }
};

module.exports = {
  lookupOltFromDumpsByMac,
  normalizeMac,
  normalizeSn,
  runLiveOnuDetails,
  runLiveOltLookup
};
