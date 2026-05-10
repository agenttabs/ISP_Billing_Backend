const mongoose = require("mongoose");
const fs = require("fs");
const collections = require("../config/collections");
const { MONGO_URI, MONGOOSE_OPTIONS } = require("../config/mongo");

mongoose.connect(MONGO_URI, MONGOOSE_OPTIONS);

const earningSchema = new mongoose.Schema({}, { strict: false });
const Earning =
  mongoose.models[collections.earnings] ||
  mongoose.model(collections.earnings, earningSchema, collections.earnings);

const data = JSON.parse(
  fs.readFileSync("D:/Michael/MichaelNuyana/isp-table/05092026/Earnings.json", "utf-8")
);

function parseDate(value) {
  if (!value) return new Date();

  try {
    if (String(value).includes("-")) {
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
    }

    const parts = String(value).split("/");
    if (parts.length !== 3) return new Date();

    const [year, month, day] = parts;
    const normalized = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const parsed = new Date(normalized);

    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  } catch (_err) {
    return new Date();
  }
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return 0;
  return Number(String(value).replace(/,/g, "").trim()) || 0;
}

function generateInvoice(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `PR-${yyyy}${mm}${dd}-${Date.now()}${Math.floor(Math.random() * 1000)}`;
}

function transform(record) {
  const transactionDate = parseDate(record.TransactionDate);

  const doc = {
    ...record,
    AccountName: record.AccountName || "",
    Invoice: record.Invoice || generateInvoice(transactionDate),
    Item: record.Item || "ISP-Client Payment",
    MOP: String(record.MOP || "CASH").toUpperCase(),
    MOPRef: record.MOPRef || record.Invoice || "",
    Cash: toNumber(record.Cash),
    DeclaredBy: record.DeclaredBy || "",
    TransactionDate: transactionDate,
    createdAt: transactionDate,
    updatedAt: transactionDate
  };

  if (record.Expenses !== undefined) {
    doc.Expenses = toNumber(record.Expenses);
  }

  return doc;
}

async function migrate() {
  try {
    await mongoose.connect(MONGO_URI, MONGOOSE_OPTIONS);

    console.log("Clearing existing earnings...");
    await Earning.deleteMany({});
    console.log("Existing earnings cleared");

    if (!Array.isArray(data)) {
      throw new Error("Earnings.json must be an array");
    }

    const formatted = data.map(transform);

    await Earning.insertMany(formatted);
    await Earning.collection.createIndex({ Invoice: 1 });
    await Earning.collection.createIndex({ MOPRef: 1 });

    console.log("Migration complete");
    console.log(`Inserted: ${formatted.length}`);
  } catch (err) {
    console.error("Migration error:", err.message);
  } finally {
    await mongoose.disconnect();
    process.exit();
  }
}

migrate();
