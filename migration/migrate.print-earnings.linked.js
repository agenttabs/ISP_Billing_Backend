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

function toPHSafeDate(value) {
  if (!value) return null;

  const str = String(value).trim();

  // format: 2026/5/15
  if (/^\d{4}\/\d{1,2}\/\d{1,2}$/.test(str)) {
    const [year, month, day] = str.split("/").map(Number);
    return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  }

  // format: 6/30/2026
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(str)) {
    const [month, day, year] = str.split("/").map(Number);
    return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  }

  // format: May 30, 2026
  const parsed = new Date(str);
  if (!Number.isNaN(parsed.getTime())) {
    return new Date(
      Date.UTC(
        parsed.getFullYear(),
        parsed.getMonth(),
        parsed.getDate(),
        12,
        0,
        0
      )
    );
  }

  return null;
}

function parseDate(value) {
  return toPHSafeDate(value) || new Date();
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
      Method: cleanString(
        line?.Method || line?.PaymentMethod || record.MOP
      ).toUpperCase(),
      Amount: toNumber(line?.Amount),
      Reference: cleanString(line?.Reference || line?.MOPRef || record.MOPRef),
      ReceiptAmount: toNumber(
        line?.ReceiptAmount || line?.Amount || record.Cash || record.TotalAmount
      ),
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
      ),
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
    record.VerifiedReference,
  ]
    .map((value) => normalizeReferenceValue(value))
    .filter(Boolean);
}

function buildLookupKeys(record = {}) {
  const accountName = cleanString(record.AccountName).toUpperCase();

  const amount = toNumber(
    record.Cash ||
      record.TotalAmount ||
      record.ReceiptAmount ||
      record.Amount
  );

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
    accountName && dayKey && amount ? `${accountName}|${dayKey}|${amount}` : "",
  ]);
}

function convertPrint(record) {
  const paymentDate = toPHSafeDate(record.PaymentDate);
  const transactionDate =
    toPHSafeDate(record.TransactionDate) || paymentDate || new Date();

  return {
    ...record,

    PaymentDate: paymentDate,
    TransactionDate: transactionDate,
    DcDate: toPHSafeDate(record.DcDate),
    DueDate: toPHSafeDate(record.DueDate),

    PaymentBreakdown: normalizePaymentBreakdown(record.PaymentBreakdown, record),

    TransferDate: cleanString(record.TransferDate || record.GCashTransferDate),
    GCashTransferDate: cleanString(record.GCashTransferDate || record.TransferDate),
    ReceiverLast4: cleanString(record.ReceiverLast4 || record.GCashReceiverLast4),
    GCashReceiverLast4: cleanString(
      record.GCashReceiverLast4 || record.ReceiverLast4
    ),

    AmountDue: toNumber(record.AmountDue),
    Balance: toNumber(record.Balance),
    CashAmount: toNumber(record.CashAmount),
    GCashAmount: toNumber(record.GCashAmount),
    PromoPrice: toNumber(record.PromoPrice),
    TSales: toNumber(record.TSales),
    TotalAmount: toNumber(record.TotalAmount),
    VSales: toNumber(record.VSales),

    EarningIds: [],
    LinkedEarningCount: 0,

    createdAt: transactionDate,
    updatedAt: transactionDate,
  };
}

function generateInvoice(date) {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");

  return `PR-${yyyy}${mm}${dd}-${Date.now()}${Math.floor(
    Math.random() * 1000
  )}`;
}

function convertEarning(record, matchedPrintId = null) {
  const transactionDate = parseDate(record.TransactionDate);

  return {
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
    Expenses: toNumber(record.Expenses),
    Quantity: toNumber(record.Quantity),
    SupplierPrice: toNumber(record.SupplierPrice),

    PaymentBreakdown: normalizePaymentBreakdown(record.PaymentBreakdown, record),

    TransferDate: cleanString(record.TransferDate || record.GCashTransferDate),
    GCashTransferDate: cleanString(record.GCashTransferDate || record.TransferDate),
    ReceiverLast4: cleanString(record.ReceiverLast4 || record.GCashReceiverLast4),
    GCashReceiverLast4: cleanString(
      record.GCashReceiverLast4 || record.ReceiverLast4
    ),

    DeclaredBy: record.DeclaredBy || "",

    TransactionDate: transactionDate,
    createdAt: transactionDate,
    updatedAt: transactionDate,

    PrintId: matchedPrintId,
  };
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
    await Promise.all([
      Print.deleteMany({}),
      Earning.deleteMany({}),
    ]);

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
              LinkedEarningCount: earningIds.length,
            },
          },
        },
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