require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const mongoose = require("mongoose");
const collections = require("../config/collections");

const WEEK_DAYS = [
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY"
];

(async () => {
  const uri = process.env.MONGO_URI_LOCAL || process.env.MONGO_URI;

  if (!uri) {
    throw new Error("Missing MONGO_URI_LOCAL or MONGO_URI in backend .env");
  }

  await mongoose.connect(uri, {
    dbName: process.env.MONGO_DB_NAME || undefined
  });

  const credentials = mongoose.connection.db.collection(collections.credentials);
  const result = await credentials.updateMany(
    {
      Type: { $regex: /^cashier$/i },
      $or: [
        { ScheduleDays: { $exists: false } },
        { ScheduleDays: null },
        { ScheduleDays: "" },
        { ScheduleDays: { $size: 0 } }
      ]
    },
    {
      $set: {
        ScheduleDays: WEEK_DAYS,
        updatedAt: new Date()
      }
    }
  );

  console.log("Cashier weekly schedule migration complete");
  console.log(`Matched cashier accounts: ${result.matchedCount}`);
  console.log(`Updated cashier accounts: ${result.modifiedCount}`);

  await mongoose.disconnect();
})().catch(async (error) => {
  console.error("CASHIER SCHEDULE MIGRATION ERROR:", error.message);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});
