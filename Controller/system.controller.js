const mongoose = require("mongoose");
const collections = require("../config/collections");
const { DATABASE_NAME, MONGO_URI } = require("../config/mongo");

const maskMongoUri = (value) =>
  String(value || "").replace(/\/\/([^:\/]+):([^@]+)@/, "//$1:***@");

exports.getDiagnostics = async (_req, res) => {
  try {
    const db = mongoose.connection.db;
    const collectionNames = await db.listCollections({}, { nameOnly: true }).toArray();

    res.json({
      runtime: {
        connected: mongoose.connection.readyState === 1,
        databaseName: db?.databaseName || DATABASE_NAME,
        mongoUri: maskMongoUri(MONGO_URI)
      },
      collections,
      availableCollections: collectionNames.map((item) => item.name).sort((a, b) =>
        a.localeCompare(b)
      )
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getSystemLogs = async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 500);
    const moduleFilter = String(req.query.module || "").trim();
    const actionFilter = String(req.query.action || "").trim();
    const accountNameFilter = String(req.query.accountName || "").trim();
    const filter = {};

    if (moduleFilter) {
      filter.Module = moduleFilter;
    }

    if (actionFilter) {
      filter.Action = actionFilter;
    }

    if (accountNameFilter) {
      filter.AccountName = accountNameFilter;
    }

    const rows = await mongoose.connection.db
      .collection(collections.systemLogs)
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();

    res.json({
      count: rows.length,
      logs: rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
