const mongoose = require("mongoose");
const fs = require("fs");
const collections = require("../config/collections");
const { MONGO_URI, MONGOOSE_OPTIONS } = require("../config/mongo");

// connect MongoDB
mongoose.connect(MONGO_URI, MONGOOSE_OPTIONS);

// flexible schema (IMPORTANT)
const clientSchema = new mongoose.Schema({}, { strict: false });
const Client =
  mongoose.models[collections.clients] ||
  mongoose.model(collections.clients, clientSchema, collections.clients);

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
