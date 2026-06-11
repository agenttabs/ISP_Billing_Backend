require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const { RouterOSClient } = require("routeros-client");
const collections = require("../config/collections");
const { MONGO_URI, MONGOOSE_OPTIONS } = require("../config/mongo");

const dumpDir = path.resolve(process.env.OLT_DUMP_DIR || path.join(__dirname, "olt-dumps"));
const showMacPath = path.join(dumpDir, "show-mac.txt");
const outputPath = path.join(dumpDir, "mikrotik-ppp-active-olt-authinfo.csv");

const normalizeGponPort = (value) => {
  const trimmed = String(value || "").trim();
  const match = trimmed.match(/^gpon-(?:olt|onu)_(\d+\/\d+\/\d+)(?::\d+)?$/i);
  return match ? `gpon-olt_${match[1]}` : trimmed;
};

const getConfiguredGponPorts = () =>
  String(process.env.OLT_GPON_PORTS || process.env.OLT_BASEINFO_PORTS || "")
    .split(",")
    .map(normalizeGponPort)
    .filter((item) => /^gpon-olt_/i.test(item));

const getBaseInfoDumpPorts = (directory) =>
  fs
    .readdirSync(directory)
    .map((file) => {
      const match = file.match(/^show-gpon-onu-baseinfo-gpon-olt_(\d+)-(\d+)-(\d+)\.txt$/i);
      return match ? `gpon-olt_${match[1]}/${match[2]}/${match[3]}` : "";
    })
    .filter(Boolean);

const normalizeMac = (value) => {
  const hex = String(value || "").replace(/[^a-f0-9]/gi, "").toUpperCase();
  if (hex.length !== 12) {
    return "";
  }

  return hex.match(/.{2}/g).join(":");
};

const cleanText = (value) =>
  String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/--\s*More\s*--/gi, "")
    .replace(/[\b\u0008]/g, "");

const csvValue = (value) => {
  const text = String(value ?? "");
  if (!/[",\n]/.test(text)) {
    return text;
  }

  return `"${text.replace(/"/g, '""')}"`;
};

const parseMacTable = (filePath) => {
  const text = cleanText(fs.readFileSync(filePath, "utf8"));
  const rowsByMac = new Map();
  const regex =
    /([0-9a-f]{2}(?::[0-9a-f]{2}){5})\s+(\d+)\s+(\S+)\s+(gpon-onu_\d+\/\d+\/\d+:\d+)\s+([^\n]*)/gi;

  let match;
  while ((match = regex.exec(text)) !== null) {
    const mac = normalizeMac(match[1]);
    if (!mac) {
      continue;
    }

    const row = {
      mac,
      vlan: String(match[2] || "").trim(),
      type: String(match[3] || "").trim(),
      port: String(match[4] || "").trim(),
      vc: String(match[5] || "").trim()
    };

    if (!rowsByMac.has(mac)) {
      rowsByMac.set(mac, []);
    }
    rowsByMac.get(mac).push(row);
  }

  return rowsByMac;
};

const parseOnuBaseInfoFiles = (directory) => {
  const rowsByOnuIndex = new Map();
  const files = fs
    .readdirSync(directory)
    .filter((file) => /^show-gpon-onu-baseinfo-.*\.txt$/i.test(file));

  for (const file of files) {
    const text = cleanText(fs.readFileSync(path.join(directory, file), "utf8"));
    const regex =
      /(gpon-onu_\d+\/\d+\/\d+:\d+)\s+(\S+)\s+(\S+)\s+(SN:\S+)\s+(\S+)/gi;

    let match;
    while ((match = regex.exec(text)) !== null) {
      const onuIndex = String(match[1] || "").trim();
      rowsByOnuIndex.set(onuIndex, {
        onuIndex,
        onuType: String(match[2] || "").trim(),
        mode: String(match[3] || "").trim(),
        authInfo: String(match[4] || "").trim(),
        state: String(match[5] || "").trim(),
        sourceFile: file
      });
    }
  }

  return rowsByOnuIndex;
};

const normalizeServerType = (value) => String(value || "").trim().toUpperCase();

const getRouterOsPort = (value) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 8728;
};

const getMikrotikConfigAC = async () => {
  const servers = await mongoose.connection.db
    .collection(collections.servers)
    .find({ ServerType: { $regex: /^AC$/i } })
    .toArray();

  const server =
    servers.find((item) => Boolean(item.IsDefault)) ||
    servers.find((item) => normalizeServerType(item.ServerType) === "AC") ||
    servers[0];

  if (!server) {
    throw new Error("No MikroTik AC server found in Servers collection.");
  }

  return {
    host: server.Address,
    user: server.User,
    password: server.Password,
    port: getRouterOsPort(server.Port)
  };
};

const getPppActiveRows = async () => {
  const config = await getMikrotikConfigAC();
  const client = new RouterOSClient(config);

  try {
    const conn = await client.connect();
    const rows = await conn.menu("/ppp/active").getAll();
    return Array.isArray(rows) ? rows : [];
  } finally {
    client.close();
  }
};

const buildReportRows = ({ pppActiveRows, macRowsByMac, onuRowsByIndex }) =>
  pppActiveRows
    .map((active) => {
      const name = String(active.name || "").trim();
      const mac = normalizeMac(
        active["caller-id"] ||
          active.callerId ||
          active["mac-address"] ||
          active.macAddress ||
          ""
      );
      const ipAddress = String(
        active.address || active["remote-address"] || active.remoteAddress || ""
      ).trim();
      const oltMatches = mac ? macRowsByMac.get(mac) || [] : [];
      const primaryOltMatch =
        oltMatches.find((row) => row.vlan === "100") || oltMatches[0] || null;
      const onuInfo = primaryOltMatch ? onuRowsByIndex.get(primaryOltMatch.port) : null;

      return {
        name,
        mac,
        ipAddress,
        vlan: primaryOltMatch?.vlan || "",
        oltPort: primaryOltMatch?.port || "",
        authInfo: String(onuInfo?.authInfo || "").replace(/^SN:/i, ""),
        onuType: onuInfo?.onuType || "",
        onuState: onuInfo?.state || "",
        matchStatus: !mac
          ? "NO ACTIVE MAC"
          : !primaryOltMatch
            ? "MAC NOT FOUND IN OLT"
            : primaryOltMatch.vlan !== "100"
              ? "FOUND BUT VLAN IS NOT 100"
              : !onuInfo
                ? "OLT PORT FOUND, AUTHINFO NOT FOUND"
                : "MATCHED",
        oltMatchCount: oltMatches.length
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

const writeCsv = (rows, filePath) => {
  const headers = [
    "MikroTikName",
    "MacAddress",
    "IPAddress",
    "VLAN",
    "OLTPort",
    "AuthInfo",
    "ONUType",
    "ONUState",
    "MatchStatus",
    "OLTMatchCount"
  ];
  const lines = [
    headers.join(","),
    ...rows.map((row) =>
      [
        row.name,
        row.mac,
        row.ipAddress,
        row.vlan,
        row.oltPort,
        row.authInfo,
        row.onuType,
        row.onuState,
        row.matchStatus,
        row.oltMatchCount
      ]
        .map(csvValue)
        .join(",")
    )
  ];

  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
};

const main = async () => {
  if (!fs.existsSync(showMacPath)) {
    throw new Error(`Missing OLT MAC dump file: ${showMacPath}`);
  }

  await mongoose.connect(MONGO_URI, MONGOOSE_OPTIONS);

  console.log("Reading OLT show-mac.txt...");
  const macRowsByMac = parseMacTable(showMacPath);

  console.log("Reading OLT GPON ONU baseinfo files...");
  const onuRowsByIndex = parseOnuBaseInfoFiles(dumpDir);
  const configuredGponPorts = getConfiguredGponPorts();
  const availableDumpPorts = getBaseInfoDumpPorts(dumpDir);
  const missingDumpPorts = configuredGponPorts.filter((port) => !availableDumpPorts.includes(port));

  console.log("Fetching MikroTik PPP active rows...");
  const pppActiveRows = await getPppActiveRows();

  const reportRows = buildReportRows({
    pppActiveRows,
    macRowsByMac,
    onuRowsByIndex
  }).filter((row) => row.matchStatus === "MATCHED");

  writeCsv(reportRows, outputPath);

  const matchedCount = reportRows.filter((row) => row.matchStatus === "MATCHED").length;
  console.log(`PPP active rows: ${pppActiveRows.length}`);
  console.log(`OLT MAC rows: ${[...macRowsByMac.values()].reduce((sum, rows) => sum + rows.length, 0)}`);
  console.log(
    `Configured GPON ports: ${configuredGponPorts.length ? configuredGponPorts.join(", ") : "(none)"}`
  );
  console.log(
    `Available GPON dump ports: ${availableDumpPorts.length ? availableDumpPorts.join(", ") : "(none)"}`
  );
  if (missingDumpPorts.length) {
    console.log(`Missing GPON dump ports: ${missingDumpPorts.join(", ")}`);
  }
  console.log(`ONU baseinfo rows: ${onuRowsByIndex.size}`);
  console.log(`Matched rows: ${matchedCount}`);
  console.log(`Report saved: ${outputPath}`);
};

main()
  .catch((error) => {
    console.error("PPP ACTIVE OLT MATCH ERROR:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
