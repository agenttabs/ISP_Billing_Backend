require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const { RouterOSClient } = require("routeros-client");
const collections = require("../config/collections");
const { MONGO_URI, MONGOOSE_OPTIONS } = require("../config/mongo");

const dumpDir = path.resolve(process.env.OLT_DUMP_DIR || path.join(__dirname, "olt-dumps"));
const showMacPath = path.join(dumpDir, "show-epon-mac.txt");
const outputPath = path.join(dumpDir, "mikrotik-ppp-active-epon-olt-mac.csv");

const normalizeMac = (value) => {
  const hex = String(value || "").replace(/[^a-f0-9]/gi, "").toUpperCase();
  if (hex.length !== 12) return "";
  return hex.match(/.{2}/g).join(":");
};

const getMacMatchKey = (value) => {
  const hex = String(value || "").replace(/[^a-f0-9]/gi, "").toUpperCase();
  return hex.length === 12 ? hex.slice(0, -2) : "";
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
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
};

const parseMacTable = (filePath) => {
  const text = cleanText(fs.readFileSync(filePath, "utf8"));
  const rowsByMac = new Map();
  const regex =
    /([0-9a-f]{2}(?::[0-9a-f]{2}){5}|[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4})\s+(\d+)\s+(\S+)\s+(epon-onu_\d+\/\d+\/\d+:\d+)\s+([^\n]*)/gi;

  let match;
  while ((match = regex.exec(text)) !== null) {
    const mac = normalizeMac(match[1]);
    if (!mac) continue;

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

const parseOnuStateFiles = (directory) => {
  const rowsByOnuIndex = new Map();
  const rowsByMac = new Map();
  const files = fs
    .readdirSync(directory)
    .filter((file) => /^show-epon-onu-state-.*\.txt$/i.test(file));

  for (const file of files) {
    const text = cleanText(fs.readFileSync(path.join(directory, file), "utf8"));
    const lines = text.split("\n");

    for (const line of lines) {
      const match = line.match(
        /\b(epon-onu_\d+\/\d+\/\d+:\d+)\b\s+(\S+)\s+(\S+)\s+([0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}|[0-9a-f]{2}(?::[0-9a-f]{2}){5})/i
      );
      if (!match) continue;

      const onuIndex = String(match[1] || "").trim();
      const onlineStatus = String(match[2] || "").trim();
      const oamStatus = String(match[3] || "").trim();
      const regMac = normalizeMac(match[4]);
      if (!regMac) continue;

      const row = {
        onuIndex,
        mac: regMac,
        vlan: "",
        type: "EPON_STATE",
        port: onuIndex,
        vc: "",
        onuType: "",
        mode: "",
        authInfo: "",
        state: `${onlineStatus} / ${oamStatus}`.trim(),
        onlineStatus,
        oamStatus,
        sourceFile: file
      };

      rowsByOnuIndex.set(onuIndex, row);
      if (!rowsByMac.has(regMac)) {
        rowsByMac.set(regMac, []);
      }
      rowsByMac.get(regMac).push(row);
    }
  }

  return {
    rowsByOnuIndex,
    rowsByMac
  };
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

const getActiveMac = (active) =>
  normalizeMac(
    active["caller-id"] ||
      active.callerId ||
      active["mac-address"] ||
      active.macAddress ||
      ""
  );

const getOltMatchesForActiveMac = (macRowsByMac, mac) => {
  const exactMatches = mac ? macRowsByMac.get(mac) || [] : [];
  if (exactMatches.length > 0) return exactMatches;

  const activeMatchKey = getMacMatchKey(mac);
  if (!activeMatchKey) return [];

  return [...macRowsByMac.entries()]
    .filter(([oltMac]) => getMacMatchKey(oltMac) === activeMatchKey)
    .flatMap(([, rows]) => rows);
};

const buildReportRows = ({ pppActiveRows, macRowsByMac, onuRowsByIndex }) =>
  pppActiveRows
    .map((active) => {
      const name = String(active.name || "").trim();
      const mac = getActiveMac(active);
      const ipAddress = String(
        active.address || active["remote-address"] || active.remoteAddress || ""
      ).trim();
      const oltMatches = getOltMatchesForActiveMac(macRowsByMac, mac);
      const primaryOltMatch =
        oltMatches.find((row) => row.vlan === "100") || oltMatches[0] || null;
      const onuInfo = primaryOltMatch ? onuRowsByIndex.get(primaryOltMatch.port) : null;

      return {
        name,
        mac,
        ipAddress,
        vlan: primaryOltMatch?.vlan || "",
        oltPort: primaryOltMatch?.port || "",
        authInfo: onuInfo?.authInfo || "",
        onuType: onuInfo?.onuType || "",
        onuState: onuInfo?.state || "",
        matchStatus: !mac
          ? "NO VALID ACTIVE MAC"
          : !primaryOltMatch
            ? "MAC NOT FOUND IN EPON OLT"
            : primaryOltMatch.vlan && primaryOltMatch.vlan !== "100"
              ? "FOUND BUT VLAN IS NOT 100"
              : "MATCHED",
        oltMatchCount: oltMatches.length
      };
    })
    .filter((row) => row.matchStatus === "MATCHED")
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
  await mongoose.connect(MONGO_URI, MONGOOSE_OPTIONS);

  console.log("Reading EPON ONU state files...");
  const stateMaps = parseOnuStateFiles(dumpDir);
  const onuRowsByIndex = stateMaps.rowsByOnuIndex;
  let macRowsByMac = stateMaps.rowsByMac;

  if (macRowsByMac.size === 0 && fs.existsSync(showMacPath)) {
    console.log("No EPON state RegMac rows found. Falling back to show-epon-mac.txt...");
    macRowsByMac = parseMacTable(showMacPath);
  }

  console.log("Fetching MikroTik PPP active rows...");
  const pppActiveRows = await getPppActiveRows();

  const reportRows = buildReportRows({
    pppActiveRows,
    macRowsByMac,
    onuRowsByIndex
  });

  writeCsv(reportRows, outputPath);

  console.log(`PPP active rows: ${pppActiveRows.length}`);
  console.log(`EPON OLT MAC rows: ${[...macRowsByMac.values()].reduce((sum, rows) => sum + rows.length, 0)}`);
  console.log(`EPON ONU state rows: ${onuRowsByIndex.size}`);
  console.log(`Matched rows: ${reportRows.length}`);
  console.log(`Report saved: ${outputPath}`);
};

main()
  .catch((error) => {
    console.error("PPP ACTIVE EPON OLT MATCH ERROR:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
