const mongoose = require("mongoose");
const collections = require("../config/collections");
const { MONGO_URI, MONGOOSE_OPTIONS } = require("../config/mongo");

async function main() {
  try {
    await mongoose.connect(MONGO_URI, MONGOOSE_OPTIONS);

    const db = mongoose.connection.db;
    const earningsCollection = db.collection(collections.earnings);

    const unmatched = await earningsCollection
      .find({
        $or: [
          { PrintId: null },
          { PrintId: { $exists: false } }
        ]
      })
      .project({
        _id: 1,
        AccountName: 1,
        Invoice: 1,
        MOP: 1,
        MOPRef: 1,
        Cash: 1,
        TransactionDate: 1,
        DeclaredBy: 1
      })
      .sort({ TransactionDate: 1, AccountName: 1 })
      .toArray();

    console.log(`Unmatched earnings: ${unmatched.length}`);
    console.log(JSON.stringify(unmatched, null, 2));
  } catch (error) {
    console.error("Verify unmatched earnings error:", error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

main();
