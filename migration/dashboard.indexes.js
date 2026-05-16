require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const mongoose = require("mongoose");
const collections = require("../config/collections");

const MONGOOSE_OPTIONS = {
  serverSelectionTimeoutMS: 10000
};

async function createIndex(collection, spec, options = {}) {
  const name = await collection.createIndex(spec, {
    background: true,
    ...options
  });
  console.log(`${collection.collectionName}: ${name}`);
}

(async () => {
  const uri = process.env.MONGO_URI_LOCAL || process.env.MONGO_URI;

  if (!uri) {
    throw new Error("Missing MONGO_URI_LOCAL or MONGO_URI in backend .env");
  }

  await mongoose.connect(uri, {
    ...MONGOOSE_OPTIONS,
    dbName: process.env.MONGO_DB_NAME || undefined
  });

  const db = mongoose.connection.db;
  const earnings = db.collection(collections.earnings);
  const print = db.collection(collections.print);
  const clients = db.collection(collections.clients);

  await createIndex(earnings, { TransactionDate: 1, MOP: 1 });
  await createIndex(earnings, { createdAt: 1, MOP: 1 });
  await createIndex(earnings, { PaymentDate: 1, MOP: 1 });
  await createIndex(earnings, { AccountNumber: 1, TransactionDate: -1 });

  await createIndex(print, { TransactionDate: 1, PaymentMethod: 1 });
  await createIndex(print, { createdAt: 1, PaymentMethod: 1 });
  await createIndex(print, { PaymentDate: 1, PaymentMethod: 1 });

  await createIndex(clients, { AuthenticationMode: 1, PaymentStatus: 1, DueDate: 1 });
  await createIndex(clients, { DueDate: 1, PaymentStatus: 1 });

  await mongoose.disconnect();
})().catch(async (error) => {
  console.error("DASHBOARD INDEX ERROR:", error.message);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});
