const mongoose = require("mongoose");
const fs = require("fs");

// connect MongoDB
mongoose.connect("mongodb://192.168.8.251:27017/isp_billing");

// flexible schema (IMPORTANT)
const clientSchema = new mongoose.Schema({}, { strict: false });
const Client = mongoose.model("Client", clientSchema);

// read JSON file
const data = JSON.parse(fs.readFileSync("C:/Users/kitzibebe/Downloads/dbsys/client.json", "utf-8"));

async function migrate() {
  try {
    await Client.insertMany(data); // direct insert
    console.log("✅ All data migrated (no changes)");
  } catch (err) {
    console.error(err);
  } finally {
    mongoose.disconnect();
  }
}

migrate();