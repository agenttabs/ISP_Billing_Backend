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
  fs.readFileSync("D:/Michael/MichaelNuyana/isp-table/05092026/print.json", "utf-8")
);

// 🔥 force convert to Date
function toDate(value) {
  if (!value) return value;

  const d = new Date(value);

  return isNaN(d.getTime()) ? value : d; // return Date if valid
}

// convert ONLY target fields
function convert(record) {
  return {
    ...record,
    PaymentDate: toDate(record.PaymentDate),
    TransactionDate: toDate(record.TransactionDate),
    DcDate: toDate(record.DcDate),
    DueDate: toDate(record.DueDate)
  };
}

async function migrate() {
  try {
    const formatted = data.map(convert);
     
    console.log("Clearing existing print...");
    await Client.deleteMany({});print cleared");
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
