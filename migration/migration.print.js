const mongoose = require("mongoose");
const fs = require("fs");
const collections = require("../config/collections");
const { MONGO_URI, MONGOOSE_OPTIONS } = require("../config/mongo");

// connect MongoDB
mongoose.connect(MONGO_URI, MONGOOSE_OPTIONS);

// flexible schema
const schema = new mongoose.Schema({}, { strict: false });

// collection: print
const Print =
  mongoose.models[collections.print] ||
  mongoose.model(collections.print, schema, collections.print);

// load JSON
const data = JSON.parse(
  fs.readFileSync("D:/Michael/MichaelNuyana/isp-table/updated/print.json", "utf-8")
);

// 🔥 force convert to Date
function toDate(value) {
  if (!value) return value;

  const d = new Date(value);

  return isNaN(d.getTime()) ? value : d; // return Date if valid
}

function cleanString(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return 0;
  return Number(String(value).replace(/,/g, "").trim()) || 0;
}

function normalizePaymentBreakdown(lines = []) {
  if (!Array.isArray(lines)) return [];

  return lines
    .map((line) => ({
      ...line,
      Method: cleanString(line?.Method || line?.PaymentMethod).toUpperCase(),
      Amount: toNumber(line?.Amount),
      Reference: cleanString(line?.Reference),
      ReceiptAmount: toNumber(line?.ReceiptAmount || line?.Amount),
      TransferDate: cleanString(
        line?.TransferDate || line?.DateOfTransfer || line?.GCashTransferDate
      ),
      ReceiverLast4: cleanString(
        line?.ReceiverLast4 || line?.GCashReceiverLast4
      )
    }))
    .filter((line) => line.Method && line.Amount > 0);
}

// convert ONLY target fields
function convert(record) {
  return {
    ...record,
    PaymentDate: toDate(record.PaymentDate),
    TransactionDate: toDate(record.TransactionDate),
    DcDate: toDate(record.DcDate),
    DueDate: toDate(record.DueDate),
    PaymentBreakdown: normalizePaymentBreakdown(record.PaymentBreakdown),
    TransferDate: cleanString(record.TransferDate || record.GCashTransferDate),
    GCashTransferDate: cleanString(record.GCashTransferDate || record.TransferDate),
    ReceiverLast4: cleanString(record.ReceiverLast4 || record.GCashReceiverLast4),
    GCashReceiverLast4: cleanString(record.GCashReceiverLast4 || record.ReceiverLast4),
    CashAmount: toNumber(record.CashAmount),
    GCashAmount: toNumber(record.GCashAmount),
    TotalAmount: toNumber(record.TotalAmount),
    Balance: toNumber(record.Balance)
  };
}

async function migrate() {
  try {
    const formatted = data.map(convert);
     
    console.log("Clearing existing print...");
    await Print.deleteMany({});
    console.log("print cleared");
    await Print.insertMany(formatted);
    await Print.collection.createIndex({ PaymentReceipt: 1 });
    await Print.collection.createIndex({ Invoice: 1 });
    await Print.collection.createIndex({ TransactionCode: 1 });

    console.log("✅ Migration complete");
    console.log("📦 Collection: print");
    console.log(`📊 Inserted: ${formatted.length}`);
  } catch (err) {
    console.error("❌ Error:", err);
  } finally {
    mongoose.disconnect();
  }
}

migrate();
