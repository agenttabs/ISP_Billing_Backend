const mongoose = require("mongoose");
const fs = require("fs");

// connect MongoDB
mongoose.connect("mongodb://192.168.8.251:27017/isp_billing");

// flexible schema
const clientSchema = new mongoose.Schema({}, { strict: false });
const Client = mongoose.model("Client", clientSchema);

// read JSON file
const data = JSON.parse(
  fs.readFileSync("C:/Users/kitzibebe/Downloads/dbsys/client.json", "utf-8")
);

// convert DueDate
function convertDueDate(record) {
  if (record.DueDate) {
    record.DueDate = new Date(record.DueDate);
  }
  return record;
}

async function migrate() {
  try {
    const formatted = data.map(convertDueDate);

    await Client.insertMany(formatted);

    console.log("✅ Migration complete (DueDate converted to Date)");
  } catch (err) {
    console.error(err);
  } finally {
    mongoose.disconnect();
  }
}

migrate();