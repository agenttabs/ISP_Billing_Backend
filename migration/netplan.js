const { MongoClient } = require("mongodb");
const fs = require("fs");
const collections = require("../config/collections");
const { DATABASE_NAME, MONGO_URI } = require("../config/mongo");
const client = new MongoClient(MONGO_URI);

async function migrate() {
  try {
    await client.connect();
    console.log("✅ Connected to MongoDB");

    const db = client.db(DATABASE_NAME);
    const collection = db.collection(collections.netPlans);

    // read file
    const raw = fs.readFileSync("D:/Michael/MichaelNuyana/isp-table/Servers/NetPlan.json", "utf-8");

    let data;
    try {
      data = JSON.parse(raw);
      console.log(`✅ Loaded ${data.length} records from JSON`);
    } catch (e) {
      console.error("❌ JSON ERROR:", e.message);
      return;
    }

    const cleaned = data
      .filter(item => item.Name)
      .map(item => ({
        name: item.Name,
        price: Number(item.Price) || 0,
        speed: item.Speed,
        type: item.TYPE,
        rx: item.Rx || null,
        tx: item.Tx || null,
        createdAt: new Date()
      }));

    console.log(`👉 Cleaned records: ${cleaned.length}`);

    // insert
    const result = await collection.insertMany(cleaned);

    console.log(`✅ Inserted ${result.insertedCount} records`);

  } catch (err) {
    console.error("❌ ERROR:", err);
  } finally {
    await client.close();
  }
}

migrate();
