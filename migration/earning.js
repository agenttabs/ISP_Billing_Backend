const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");
const collections = require("../config/collections");
const { MONGO_URI, MONGOOSE_OPTIONS } = require("../config/mongo");
const FILE_PATH = path.join("D:/Michael/MichaelNuyana/isp-table/Servers/", "Earnings.json");

// ✅ parse old date format: 2025/5/2
function parseDate(value) {
  if (!value) return new Date();

  try {
    // already ISO-like
    if (value.includes("-")) {
      const d = new Date(value);
      return isNaN(d.getTime()) ? new Date() : d;
    }

    // old format: YYYY/M/D
    const parts = String(value).split("/");
    if (parts.length !== 3) return new Date();

    const [year, month, day] = parts;

    const normalized = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const d = new Date(normalized);

    return isNaN(d.getTime()) ? new Date() : d;
  } catch (err) {
    console.log("❌ Date parse error:", value);
    return new Date();
  }
}

// ✅ convert string/number to real number
function toNumber(val) {
  if (val === null || val === undefined || val === "") return 0;
  return Number(String(val).replace(/,/g, "").trim()) || 0;
}

// ✅ generate invoice if missing
function generateInvoice(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `PR-${yyyy}${mm}${dd}-${Date.now()}${Math.floor(Math.random() * 1000)}`;
}

async function migrate() {
  try {
    await mongoose.connect(MONGO_URI, MONGOOSE_OPTIONS);
    console.log("✅ Connected to MongoDB");

    const db = mongoose.connection.db;
    const collection = db.collection(collections.earnings);

    // read json file
    const raw = fs.readFileSync(FILE_PATH, "utf-8");
    const data = JSON.parse(raw);

    if (!Array.isArray(data)) {
      throw new Error("Earnings.json must be an array");
    }

    console.log(`📦 Found ${data.length} records in JSON`);

    let insertedCount = 0;
    let skippedCount = 0;

    for (const item of data) {
      const txDate = parseDate(item.TransactionDate);

      const doc = {
        AccountName: item.AccountName || "",
        Invoice: item.Invoice || generateInvoice(txDate),
        Item: item.Item || "ISP-Client Payment",
        MOP: (item.MOP || "CASH").toUpperCase(),
        MOPRef: item.MOPRef || item.Invoice || "",
        Cash: toNumber(item.Cash),
        DeclaredBy: item.DeclaredBy || "",
        TransactionDate: txDate,
        createdAt: txDate,
        updatedAt: txDate
      };

      // ✅ optional: only include Expenses if you still want it
      if (item.Expenses !== undefined) {
        doc.Expenses = toNumber(item.Expenses);
      }

      // ✅ skip duplicate invoice
      const existing = await collection.findOne({ Invoice: doc.Invoice });

      if (existing) {
        console.log(`⚠️ Skipped duplicate invoice: ${doc.Invoice}`);
        skippedCount++;
        continue;
      }

      await collection.insertOne(doc);
      console.log(`✅ Inserted: ${doc.Invoice} | ${doc.AccountName}`);
      insertedCount++;
    }

    console.log("\n🎉 MIGRATION COMPLETE");
    console.log(`✅ Inserted: ${insertedCount}`);
    console.log(`⚠️ Skipped duplicates: ${skippedCount}`);
  } catch (err) {
    console.error("❌ Migration error:", err.message);
  } finally {
    await mongoose.disconnect();
    console.log("🔌 Disconnected from MongoDB");
    process.exit();
  }
}

migrate();
