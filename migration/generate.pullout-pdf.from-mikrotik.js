const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const mongoose = require("mongoose");
const { jsPDF } = require("jspdf");
const { RouterOSClient } = require("routeros-client");
const collections = require("../config/collections");

const MIKROTIK_IP = "10.0.0.2";
const MIKROTIK_USERNAME = "mdn";
const MIKROTIK_PASSWORD = "qwerty12345";
const MIKROTIK_PORT = 8728;
const PULLOUT_PROFILE = "dc-putol";
const PULLOUT_DUE_DAYS = 20;
const OUTPUT_FILE = "D:/pullout-list.pdf";

const normalize = (value) => String(value ?? "").trim();

const isBlankRemark = (row) => {
  const value = normalize(row?.comment || row?.remarks || row?.Remark || row?.Remarks);
  return !value || value === "-";
};

const getSecretName = (row) => normalize(row?.name || row?.Name || row?.user || row?.username);

const getSecretProfile = (row) => normalize(row?.profile || row?.Profile);

const getClientAccountName = (client) =>
  normalize(client?.AccountName || client?.accountName || client?.Username || client?.username);

const getClientName = (client) =>
  normalize(client?.ClientName || client?.clientName || client?.Name || client?.name);

const parseDateValue = (value) => {
  if (!value) {
    return null;
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }

  const raw = normalize(value);
  if (!raw) {
    return null;
  }

  const direct = new Date(raw);
  if (!Number.isNaN(direct.getTime())) {
    return direct;
  }

  const slashMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (slashMatch) {
    const [, month, day, year] = slashMatch;
    const date = new Date(Number(year), Number(month) - 1, Number(day));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  return null;
};

const startOfLocalDay = (date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate());

const getOverdueDays = (dueDate) => {
  const parsed = parseDateValue(dueDate);
  if (!parsed) {
    return null;
  }

  const today = startOfLocalDay(new Date());
  const due = startOfLocalDay(parsed);
  return Math.floor((today.getTime() - due.getTime()) / 86400000);
};

const formatDate = (value) => {
  const parsed = parseDateValue(value);
  if (!parsed) {
    return "-";
  }

  return parsed.toLocaleDateString("en-PH", {
    year: "numeric",
    month: "short",
    day: "2-digit"
  });
};

const buildOutputPath = () => {
  if (OUTPUT_FILE) {
    return path.resolve(OUTPUT_FILE);
  }

  const outputDir = path.join(__dirname, "output");
  fs.mkdirSync(outputDir, { recursive: true });

  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 19);

  return path.join(outputDir, `pullout-dc-putol-empty-remarks-${stamp}.pdf`);
};

const drawHeader = (doc, { host, profile, dueDays, total }) => {
  const pageWidth = doc.internal.pageSize.getWidth();

  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text("Pull Out Checklist", pageWidth / 2, 16, { align: "center" });

  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.text(`MikroTik: ${host}`, 14, 25);
  doc.text(`Profile: ${profile}`, 14, 31);
  doc.text(`Remarks/Comment: Empty only`, 14, 37);
  doc.text(`Due Date: ${dueDays}+ day(s) overdue`, 100, 37);
  doc.text(`Generated: ${new Date().toLocaleString("en-PH")}`, 14, 43);
  doc.text(`Records: ${total}`, pageWidth - 14, 43, { align: "right" });

  doc.setDrawColor(120);
  doc.line(14, 48, pageWidth - 14, 48);
};

const drawTableHeader = (doc, y) => {
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.text("Done", 16, y);
  doc.text("No.", 34, y);
  doc.text("PPPoE Name", 50, y);
  doc.text("Client", 105, y);
  doc.text("Due Date", 160, y);
  doc.text("Days", 195, y);
  doc.text("Profile", 215, y);
  doc.text("Comment / Remarks", 245, y);
  doc.line(14, y + 3, 282, y + 3);
};

const generatePdf = ({ rows, host, profile, dueDays, outputPath }) => {
  const doc = new jsPDF({
    orientation: "landscape",
    unit: "mm",
    format: "a4"
  });

  const pageHeight = doc.internal.pageSize.getHeight();
  const pageWidth = doc.internal.pageSize.getWidth();
  let y = 56;

  drawHeader(doc, { host, profile, dueDays, total: rows.length });
  drawTableHeader(doc, y);
  y += 9;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);

  if (!rows.length) {
    doc.text("No PPPoE secrets found for this condition.", pageWidth / 2, y + 10, {
      align: "center"
    });
  }

  rows.forEach((row, index) => {
    if (y > pageHeight - 16) {
      doc.addPage();
      drawHeader(doc, { host, profile, dueDays, total: rows.length });
      y = 56;
      drawTableHeader(doc, y);
      y += 9;
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
    }

    doc.rect(18, y - 4, 4, 4);
    doc.text(String(index + 1), 34, y);
    doc.text(row.pppoeName || "-", 50, y, { maxWidth: 48 });
    doc.text(row.clientName || "-", 105, y, { maxWidth: 48 });
    doc.text(row.dueDateText || "-", 160, y, { maxWidth: 30 });
    doc.text(String(row.overdueDays ?? "-"), 195, y);
    doc.text(row.profile || "-", 215, y, { maxWidth: 24 });
    doc.text("-", 245, y);
    doc.line(14, y + 3, 282, y + 3);
    y += 8;
  });

  const pageCount = doc.getNumberOfPages();
  for (let page = 1; page <= pageCount; page += 1) {
    doc.setPage(page);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.text(`Page ${page} of ${pageCount}`, pageWidth - 14, pageHeight - 8, {
      align: "right"
    });
  }

  fs.writeFileSync(outputPath, Buffer.from(doc.output("arraybuffer")));
};

const loadClientMap = async (accountNames) => {
  const uri = process.env.MONGO_URI_LOCAL || process.env.MONGO_URI;
  if (!uri) {
    throw new Error("Missing MONGO_URI_LOCAL or MONGO_URI in backend .env");
  }

  await mongoose.connect(uri, {
    dbName: process.env.MONGO_DB_NAME || undefined
  });

  const clients = await mongoose.connection.db
    .collection(collections.clients)
    .find(
      {
        $or: [
          { AccountName: { $in: accountNames } },
          { accountName: { $in: accountNames } }
        ]
      },
      {
        projection: {
          AccountName: 1,
          accountName: 1,
          ClientName: 1,
          clientName: 1,
          DueDate: 1,
          dueDate: 1,
          Status: 1,
          status: 1
        }
      }
    )
    .toArray();

  return new Map(
    clients.map((client) => [getClientAccountName(client).toLowerCase(), client])
  );
};

const main = async () => {
  const host = normalize(MIKROTIK_IP);
  const user = normalize(MIKROTIK_USERNAME);
  const password = normalize(MIKROTIK_PASSWORD);
  const profile = normalize(PULLOUT_PROFILE) || "dc-putol";
  const dueDays = Number(PULLOUT_DUE_DAYS) || 0;
  const port = Number(MIKROTIK_PORT) || 8728;
  const outputPath = buildOutputPath();

  if (!host || !user || !password) {
    throw new Error("Please set MIKROTIK_IP, MIKROTIK_USERNAME, and MIKROTIK_PASSWORD at the top of this file.");
  }

  console.log(`Connecting to MikroTik ${host}:${port}...`);

  const client = new RouterOSClient({
    host,
    user,
    password,
    port
  });

  try {
    const conn = await client.connect();
    const secrets = await conn.menu("/ppp/secret").getAll();
    const profileKey = profile.toLowerCase();
    const mikrotikRows = (Array.isArray(secrets) ? secrets : [])
      .filter((row) => getSecretProfile(row).toLowerCase() === profileKey)
      .filter(isBlankRemark)
      .sort((a, b) => getSecretName(a).localeCompare(getSecretName(b)));

    const accountNames = mikrotikRows.map(getSecretName).filter(Boolean);
    console.log(`MikroTik matched before due-date filter: ${mikrotikRows.length}`);
    console.log("Checking client collection due dates...");

    const clientMap = await loadClientMap(accountNames);
    const rows = mikrotikRows
      .map((row) => {
        const pppoeName = getSecretName(row);
        const clientRecord = clientMap.get(pppoeName.toLowerCase());
        const dueDate = clientRecord?.DueDate || clientRecord?.dueDate;
        const overdueDays = getOverdueDays(dueDate);

        return {
          pppoeName,
          profile: getSecretProfile(row),
          clientName: getClientName(clientRecord) || pppoeName,
          dueDate,
          dueDateText: formatDate(dueDate),
          overdueDays
        };
      })
      .filter((row) => row.overdueDays !== null && row.overdueDays >= dueDays)
      .sort((a, b) => {
        if (a.overdueDays !== b.overdueDays) {
          return b.overdueDays - a.overdueDays;
        }

        return a.pppoeName.localeCompare(b.pppoeName);
      });

    generatePdf({
      rows,
      host,
      profile,
      dueDays,
      outputPath
    });

    console.log("Pull out PDF generated successfully.");
    console.log(`Profile matched: ${profile}`);
    console.log(`Due date filter: ${dueDays}+ day(s) overdue`);
    console.log(`Empty remarks/comment records after due-date filter: ${rows.length}`);
    console.log(`File: ${outputPath}`);
  } finally {
    client.close();
    await mongoose.disconnect().catch(() => {});
  }
};

main().catch((error) => {
  console.error("PULL OUT PDF ERROR:", error.message);
  process.exit(1);
});
