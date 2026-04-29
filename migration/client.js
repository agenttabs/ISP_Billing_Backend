const mongoose = require("mongoose");
const fs = require("fs");
const collections = require("../config/collections");
const { MONGO_URI, MONGOOSE_OPTIONS } = require("../config/mongo");

// connect
 mongoose.connect(MONGO_URI, MONGOOSE_OPTIONS);

// flexible schema
const clientSchema = new mongoose.Schema({}, { strict: false });
const Client =
  mongoose.models[collections.clients] ||
  mongoose.model(collections.clients, clientSchema, collections.clients);

// read JSON
const data = JSON.parse(
  fs.readFileSync("D:/Michael/MichaelNuyana/isp-table/Servers/client.json", "utf-8")
);

// 🔥 DATE PARSER
const parseDate = (value) => {
  if (!value || value === "N/A") return null;

  const parts = value.split("/");
  if (parts.length === 3) {
    const [month, day, year] = parts;
    return new Date(`${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`);
  }

  return new Date(value);
};

// 🔥 NUMBER PARSER
const parseNumber = (value) => {
  if (!value || value === "N/A") return 0;
  return Number(value.toString().replace(/,/g, ""));
};

// 🔥 CLEAN STRING
const cleanString = (value) => {
  if (!value || value === "N/A" || value === "") return null;
  return value.toString().trim();
};

// 🔥 TRANSFORM RECORD
function transform(record) {
  return {
    ...record,

    // dates
    DueDate: parseDate(record.DueDate),
    DateEntry: parseDate(record.DateEntry),

    // numbers
    AmountDue: parseNumber(record.AmountDue),
    Balance: parseNumber(record.Balance),

    // clean strings
    Address: cleanString(record.Address),
    Email: cleanString(record.Email),
    Facebook: cleanString(record.Facebook),
    IPaddress: cleanString(record.IPaddress),
    LatLong: cleanString(record.LatLong),
    LatestBilling: cleanString(record.LatestBilling),
    LatestReceipt: cleanString(record.LatestReceipt),
    PromoCode: cleanString(record.PromoCode),
    Router: cleanString(record.Router),
    TelegramChatID: cleanString(record.TelegramChatID),
    TelegramToken: cleanString(record.TelegramToken),
    Note: cleanString(record.Note),
    MacAddress: record.MacAddress ? cleanString(record.MacAddress) : null,
  };
}

// 🚀 MIGRATION
async function migrate() {
  try {
    await mongoose.connect(MONGO_URI);

    console.log("🔄 Clearing existing clients...");
    
    // ✅ OPTION 2: delete all documents (keep collection)
    await Client.deleteMany({});

    console.log("✅ Existing data cleared");

    const formatted = data.map(transform);

    await Client.insertMany(formatted);

    console.log("✅ Migration complete (all fields cleaned)");
  } catch (err) {
    console.error("❌ Error:", err);
  } finally {
    mongoose.disconnect();
  }
}

migrate();
