require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const mongoose = require("mongoose");

async function getIndexes(db, names) {
  for (const name of names) {
    try {
      const indexes = await db.collection(name).indexes();
      return { name, indexes };
    } catch (error) {
      // Try the next collection name variant.
    }
  }

  return { name: names[0], indexes: [], missing: true };
}

(async () => {
  const uri = process.env.MONGO_URI_LOCAL || process.env.MONGO_URI;

  if (!uri) {
    throw new Error("Missing MONGO_URI_LOCAL or MONGO_URI in backend .env");
  }

  await mongoose.connect(uri, { dbName: process.env.MONGO_DB_NAME || undefined });

  const db = mongoose.connection.db;
  const targets = [
    ["print"],
    ["Earnings", "earnings"],
    ["Clients", "clients"],
  ];

  for (const names of targets) {
    const result = await getIndexes(db, names);
    console.log("\n=== " + result.name.toUpperCase() + " ===");

    if (result.missing) {
      console.log("Collection not found.");
      continue;
    }

    for (const index of result.indexes) {
      console.log(JSON.stringify(index, null, 2));
    }
  }

  await mongoose.disconnect();
})().catch(async (error) => {
  console.error("VERIFY INDEXES ERROR:", error.message);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});
