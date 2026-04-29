const mongoose = require('mongoose');
const data = require('./Transaction.json');
const collections = require("../config/collections");
const { MONGO_URI, MONGOOSE_OPTIONS } = require("../config/mongo");

mongoose.connect(MONGO_URI, MONGOOSE_OPTIONS);

// 🔥 Safe date parser (handles ALL your formats)
const parseDate = (value) => {
  if (!value) return null;

  // normalize "2025/5/2" → "2025-05-02"
  if (value.includes('/')) {
    const parts = value.split(' ')[0].split('/');

    if (parts[0].length === 4) {
      // yyyy/mm/dd
      return new Date(`${parts[0]}-${parts[1].padStart(2,'0')}-${parts[2].padStart(2,'0')}`);
    } else {
      // mm/dd/yyyy
      return new Date(`${parts[2]}-${parts[0].padStart(2,'0')}-${parts[1].padStart(2,'0')}`);
    }
  }

  // fallback (April 17, 2025, etc.)
  return new Date(value);
};

async function migrate() {
  await mongoose.connect(MONGO_URI, MONGOOSE_OPTIONS);

  const collection = mongoose.connection.db.collection(collections.print);

  const cleaned = data.map(item => ({
    ...item,

    TransactionDate: parseDate(item.TransactionDate),
    DueDate: parseDate(item.DueDate),
    PaymentDate: parseDate(item.PaymentDate),
    DcDate: parseDate(item.DcDate),
  }));

  await collection.insertMany(cleaned);

  console.log('✅ Migration complete');
  process.exit();
}

migrate();
