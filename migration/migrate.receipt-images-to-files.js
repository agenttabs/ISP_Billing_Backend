require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const mongoose = require("mongoose");
const collections = require("../config/collections");
const { MONGO_URI, MONGOOSE_OPTIONS } = require("../config/mongo");

const isCommit = process.argv.includes("--commit");
const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
const limit = limitArg ? Math.max(Number(limitArg.split("=")[1]) || 0, 0) : 0;
const shouldListRows = limit > 0;

const uploadRoot =
  process.env.UPLOAD_ROOT || path.join(__dirname, "..", "..", "isp_billing_uploads");
const receiptUploadRoot = path.join(uploadRoot, "receipts");

const sanitizeFileToken = (value) =>
  String(value || "")
    .trim()
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

const getDateFolder = (row) => {
  const value = row.TransactionDate || row.PaymentDate || row.createdAt || new Date();
  const date = new Date(value);
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  const year = safeDate.getFullYear();
  const month = String(safeDate.getMonth() + 1).padStart(2, "0");
  const day = String(safeDate.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
};

const parseReceiptImage = (value) => {
  const raw = String(value || "").trim();
  if (!raw) {
    return null;
  }

  const dataUrlMatch = raw.match(/^data:image\/(png|jpe?g|webp);base64,(.+)$/i);
  if (dataUrlMatch) {
    return {
      extension: dataUrlMatch[1].toLowerCase() === "jpeg" ? "jpg" : dataUrlMatch[1].toLowerCase(),
      buffer: Buffer.from(dataUrlMatch[2], "base64")
    };
  }

  if (/^[A-Za-z0-9+/=\r\n]+$/.test(raw) && raw.length > 100) {
    return {
      extension: "jpg",
      buffer: Buffer.from(raw.replace(/\s+/g, ""), "base64")
    };
  }

  return null;
};

const buildFileName = (row, extension) => {
  const baseName =
    sanitizeFileToken(row.PaymentReceipt) ||
    sanitizeFileToken(row.Invoice) ||
    sanitizeFileToken(row.MOPRef) ||
    sanitizeFileToken(row.ReferenceNumber) ||
    `earning-${String(row._id)}`;
  const hash = crypto
    .createHash("sha1")
    .update(String(row._id))
    .digest("hex")
    .slice(0, 10);

  return `${baseName}-${hash}.${extension}`;
};

const formatMoney = (value) =>
  Number(value || 0).toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });

const formatLogLine = (status, row, publicPath) =>
  [
    status,
    `id=${row._id}`,
    `client="${row.ClientName || row.Name || "-"}"`,
    `account="${row.AccountName || "-"}"`,
    `accountNo="${row.AccountNumber || "-"}"`,
    `method="${row.MOP || row.PaymentMethod || "-"}"`,
    `amount=PHP ${formatMoney(row.Cash || row.TotalAmount || row.ReceiptAmount || 0)}`,
    `receipt="${row.PaymentReceipt || "-"}"`,
    `invoice="${row.Invoice || "-"}"`,
    `ref="${row.MOPRef || row.ReferenceNumber || "-"}"`,
    `date="${new Date(row.TransactionDate || row.PaymentDate || row.createdAt || Date.now()).toLocaleString("en-PH")}"`,
    `path="${publicPath}"`
  ].join(" | ");

async function main() {
  await mongoose.connect(MONGO_URI, MONGOOSE_OPTIONS);

  const earnings = mongoose.connection.db.collection(collections.earnings);
  const query = {
    ReceiptImage: {
      $exists: true,
      $type: "string",
      $regex: /^(data:image\/|[A-Za-z0-9+/=]{100,})/
    },
    $or: [
      { ReceiptImageStorage: { $exists: false } },
      { ReceiptImageStorage: { $ne: "file" } }
    ]
  };

  let cursor = earnings
    .find(query, {
      projection: {
        _id: 1,
        AccountName: 1,
        AccountNumber: 1,
        Cash: 1,
        ClientName: 1,
        PaymentReceipt: 1,
        Invoice: 1,
        MOP: 1,
        MOPRef: 1,
        Name: 1,
        PaymentMethod: 1,
        ReferenceNumber: 1,
        ReceiptAmount: 1,
        ReceiptImage: 1,
        TotalAmount: 1,
        TransactionDate: 1,
        PaymentDate: 1,
        createdAt: 1
      }
    })
    .sort({ createdAt: 1, _id: 1 });

  if (limit > 0) {
    cursor = cursor.limit(limit);
  }

  let scanned = 0;
  let migrated = 0;
  let skipped = 0;
  let failed = 0;

  for await (const row of cursor) {
    scanned += 1;

    try {
      const parsed = parseReceiptImage(row.ReceiptImage);
      if (!parsed?.buffer?.length) {
        skipped += 1;
        continue;
      }

      const dateFolder = getDateFolder(row);
      const fileName = buildFileName(row, parsed.extension);
      const folderPath = path.join(receiptUploadRoot, dateFolder);
      const filePath = path.join(folderPath, fileName);
      const publicPath = `/uploads/receipts/${dateFolder}/${fileName}`;

      if (isCommit) {
        fs.mkdirSync(folderPath, { recursive: true });
        fs.writeFileSync(filePath, parsed.buffer);
        await earnings.updateOne(
          { _id: row._id },
          {
            $set: {
              ReceiptImage: publicPath,
              ReceiptImageStorage: "file",
              ReceiptImageMigratedAt: new Date(),
              updatedAt: new Date()
            }
          }
        );
      }

      migrated += 1;
      if (shouldListRows) {
        console.log(formatLogLine(isCommit ? "MIGRATED" : "DRY RUN", row, publicPath));
      }
    } catch (error) {
      failed += 1;
      console.error(`FAILED ${row._id}: ${error.message}`);
    }
  }

  console.log(
    JSON.stringify(
      {
        mode: isCommit ? "commit" : "dry-run",
        uploadRoot,
        scanned,
        migrated,
        skipped,
        failed
      },
      null,
      2
    )
  );

  await mongoose.disconnect();

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch(async (error) => {
  console.error("Receipt image migration error:", error);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});
