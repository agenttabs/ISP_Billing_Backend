const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");
const collections = require("../config/collections");
const { MONGO_URI, MONGOOSE_OPTIONS } = require("../config/mongo");

const schema = new mongoose.Schema({}, { strict: false });

const Print =
  mongoose.models[collections.print] ||
  mongoose.model(collections.print, schema, collections.print);

const Earning =
  mongoose.models[collections.earnings] ||
  mongoose.model(collections.earnings, schema, collections.earnings);

const printJsonPath = "D:/Michael/MichaelNuyana/isp-table/updated/print.json";
const earningsJsonPath = "D:/Michael/MichaelNuyana/isp-table/updated/Earnings.json";

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function toDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseDate(value) {
  if (!value) return new Date();

  const direct = new Date(value);
  if (!Number.isNaN(direct.getTime())) {
    return direct;
  }

  const parts = String(value).split("/");
  if (parts.length === 3) {
    const [year, month, day] = parts;
    const normalized = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const retry = new Date(normalized);
    if (!Number.isNaN(retry.getTime())) {
      return retry;
    }
  }

  return new Date();
}

function cleanString(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return 0;
  return Number(String(value).replace(/,/g, "").trim()) || 0;
}

function normalizeReferenceValue(value) {
  return String(value || "")
    .replace(/\s+/g, "")
    .trim()
    .toUpperCase();
}

function normalizePaymentBreakdown(lines = [], record = {}) {
  if (!Array.isArray(lines)) return [];

  return lines
    .map((line) => ({
      ...line,
      Method: cleanString(line?.Method || line?.PaymentMethod || record.MOP).toUpperCase(),
      Amount: toNumber(line?.Amount),
      Reference: cleanString(line?.Reference || line?.MOPRef || record.MOPRef),
      ReceiptAmount: toNumber(line?.ReceiptAmount || line?.Amount || record.Cash || record.TotalAmount),
      TransferDate: cleanString(
        line?.TransferDate ||
          line?.DateOfTransfer ||
          line?.GCashTransferDate ||
          record.TransferDate ||
          record.GCashTransferDate
      ),
      ReceiverLast4: cleanString(
        line?.ReceiverLast4 ||
          line?.GCashReceiverLast4 ||
          record.ReceiverLast4 ||
          record.GCashReceiverLast4
      )
    }))
    .filter((line) => line.Method && line.Amount > 0);
}

function getReferenceCandidates(record = {}) {
  return [
    record.Invoice,
    record.PaymentReceipt,
    record.TransactionCode,
    record.MOPRef,
    record.ReferenceNumber,
    record.VerifiedReference
  ]
    .map((value) => normalizeReferenceValue(value))
    .filter(Boolean);
}

function buildLookupKeys(record = {}) {
  const accountName = cleanString(record.AccountName).toUpperCase();
  const amount = toNumber(record.Cash || record.TotalAmount || record.ReceiptAmount || record.Amount);
  const dateValue =
    record.TransactionDate ||
    record.PaymentDate ||
    record.createdAt ||
    record.updatedAt ||
    null;
  const date = dateValue ? parseDate(dateValue) : null;
  const dayKey = date ? date.toISOString().slice(0, 10) : "";

  return new Set([
    ...getReferenceCandidates(record),
    accountName && dayKey ? `${accountName}|${dayKey}` : "",
    accountName && amount ? `${accountName}|${amount}` : "",
    accountName && dayKey && amount ? `${accountName}|${dayKey}|${amount}` : ""
  ]);
}

function convertPrint(record) {
  const paymentDate = toDate(record.PaymentDate);
  const transactionDate = toDate(record.TransactionDate) || paymentDate || new Date();

  return {
    ...record,
    PaymentDate: paymentDate,
    TransactionDate: transactionDate,
    DcDate: toDate(record.DcDate),
    DueDate: toDate(record.DueDate),
    PaymentBreakdown: normalizePaymentBreakdown(record.PaymentBreakdown, record),
    TransferDate: cleanString(record.TransferDate || record.GCashTransferDate),
    GCashTransferDate: cleanString(record.GCashTransferDate || record.TransferDate),
    ReceiverLast4: cleanString(record.ReceiverLast4 || record.GCashReceiverLast4),
    GCashReceiverLast4: cleanString(record.GCashReceiverLast4 || record.ReceiverLast4),
    CashAmount: toNumber(record.CashAmount),
    GCashAmount: toNumber(record.GCashAmount),
    TotalAmount: toNumber(record.TotalAmount),
    Balance: toNumber(record.Balance),
    EarningIds: [],
    LinkedEarningCount: 0
  };
}

function generateInvoice(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `PR-${yyyy}${mm}${dd}-${Date.now()}${Math.floor(Math.random() * 1000)}`;
}

function convertEarning(record, matchedPrintId = null) {
  const transactionDate = parseDate(record.TransactionDate);

  const doc = {
    ...record,
    AccountName: record.AccountName || "",
    Invoice: record.Invoice || generateInvoice(transactionDate),
    Item: record.Item || "ISP-Client Payment",
    MOP: String(record.MOP || "CASH").toUpperCase(),
    MOPRef: record.MOPRef || record.Invoice || "",
    Cash: toNumber(record.Cash),
    CashAmount: toNumber(record.CashAmount),
    GCashAmount: toNumber(record.GCashAmount),
    ReceiptAmount: toNumber(record.ReceiptAmount || record.Cash),
    PaymentBreakdown: normalizePaymentBreakdown(record.PaymentBreakdown, record),
    TransferDate: cleanString(record.TransferDate || record.GCashTransferDate),
    GCashTransferDate: cleanString(record.GCashTransferDate || record.TransferDate),
    ReceiverLast4: cleanString(record.ReceiverLast4 || record.GCashReceiverLast4),
    GCashReceiverLast4: cleanString(record.GCashReceiverLast4 || record.ReceiverLast4),
    DeclaredBy: record.DeclaredBy || "",
    TransactionDate: transactionDate,
    createdAt: transactionDate,
    updatedAt: transactionDate,
    PrintId: matchedPrintId
  };

  if (record.Expenses !== undefined) {
    doc.Expenses = toNumber(record.Expenses);
  }

  return doc;
}

async function migrate() {
  try {
    await mongoose.connect(MONGO_URI, MONGOOSE_OPTIONS);

    const printData = readJson(printJsonPath);
    const earningsData = readJson(earningsJsonPath);

    if (!Array.isArray(printData)) {
      throw new Error(`${path.basename(printJsonPath)} must be an array`);
    }

    if (!Array.isArray(earningsData)) {
      throw new Error(`${path.basename(earningsJsonPath)} must be an array`);
    }

    console.log("Clearing existing print and earnings...");
    await Promise.all([Print.deleteMany({}), Earning.deleteMany({})]);

    const formattedPrint = printData.map(convertPrint);
    const insertedPrint = await Print.insertMany(formattedPrint);

    const printLookup = new Map();
    insertedPrint.forEach((row) => {
      buildLookupKeys(row).forEach((key) => {
        if (key && !printLookup.has(key)) {
          printLookup.set(key, row);
        }
      });
    });

    const formattedEarnings = earningsData.map((record) => {
      const matchedPrint = Array.from(buildLookupKeys(record))
        .map((key) => printLookup.get(key))
        .find(Boolean);

      return convertEarning(record, matchedPrint?._id || null);
    });

    const insertedEarnings = await Earning.insertMany(formattedEarnings);

    const earningsByPrintId = new Map();
    insertedEarnings.forEach((row) => {
      if (!row.PrintId) return;
      const key = String(row.PrintId);
      if (!earningsByPrintId.has(key)) {
        earningsByPrintId.set(key, []);
      }
      earningsByPrintId.get(key).push(row._id);
    });

    const bulkPrintUpdates = [];
    earningsByPrintId.forEach((earningIds, printId) => {
      bulkPrintUpdates.push({
        updateOne: {
          filter: { _id: new mongoose.Types.ObjectId(printId) },
          update: {
            $set: {
              EarningIds: earningIds,
              LinkedEarningCount: earningIds.length
            }
          }
        }
      });
    });

    if (bulkPrintUpdates.length) {
      await Print.bulkWrite(bulkPrintUpdates);
    }

    await Print.collection.createIndex({ PaymentReceipt: 1 });
    await Print.collection.createIndex({ Invoice: 1 });
    await Print.collection.createIndex({ TransactionCode: 1 });
    await Print.collection.createIndex({ TransactionDate: 1 });
    await Print.collection.createIndex({ PaymentDate: 1 });
    await Print.collection.createIndex({ EarningIds: 1 });

    await Earning.collection.createIndex({ Invoice: 1 });
    await Earning.collection.createIndex({ MOPRef: 1 });
    await Earning.collection.createIndex({ TransactionDate: 1 });
    await Earning.collection.createIndex({ PrintId: 1 });

    const linkedCount = insertedEarnings.filter((row) => row.PrintId).length;

    console.log("Linked migration complete");
    console.log(`Print inserted: ${insertedPrint.length}`);
    console.log(`Earnings inserted: ${insertedEarnings.length}`);
    console.log(`Earnings linked to print: ${linkedCount}`);
  } catch (err) {
    console.error("Linked migration error:", err);
  } finally {
    await mongoose.disconnect();
    process.exit();
  }
}

migrate();
