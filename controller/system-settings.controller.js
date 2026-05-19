const mongoose = require("mongoose");
const collections = require("../config/collections");
const { writeAuditLog } = require("../services/audit-log.service");
const {
  getSystemSettings,
  saveSystemSettings
} = require("../services/system-settings.service");

const syncDisconnectGraceDays = async (graceDays) => {
  const numericGraceDays = Number(graceDays);
  if (!Number.isFinite(numericGraceDays) || numericGraceDays < 0) {
    return;
  }

  const payload = {
    GraceDays: Math.floor(numericGraceDays),
    updatedAt: new Date()
  };

  await Promise.all([
    mongoose.connection.db
      .collection(collections.mikrotikDcBatch)
      .updateOne({}, { $set: payload, $setOnInsert: { createdAt: new Date() } }, { upsert: true }),
    mongoose.connection.db
      .collection(collections.mikrotikDueDisconnectBatch)
      .updateOne({}, { $set: payload, $setOnInsert: { createdAt: new Date() } }, { upsert: true })
  ]);
};

const syncReceiptCompanyName = async (companyName) => {
  const normalizedCompanyName = String(companyName || "").trim();
  if (!normalizedCompanyName) {
    return;
  }

  await mongoose.connection.db.collection(collections.printReceipt).updateOne(
    {},
    {
      $set: {
        CompanyName: normalizedCompanyName,
        updatedAt: new Date()
      },
      $setOnInsert: { createdAt: new Date() }
    },
    { upsert: true }
  );
};

exports.getSystemSettings = async (_req, res) => {
  try {
    const settings = await getSystemSettings();
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.saveSystemSettings = async (req, res) => {
  try {
    const settings = await saveSystemSettings(req.body || {});
    await Promise.all([
      syncDisconnectGraceDays(settings.DisconnectAfterDueDays),
      syncReceiptCompanyName(settings.CompanyName)
    ]);

    res.json(settings);

    await writeAuditLog({
      req,
      module: "SYSTEM_SETTINGS",
      action: "SAVE_CONFIG",
      targetType: "SYSTEM_SETTINGS",
      status: "SUCCESS",
      summary: "System settings saved.",
      values: settings
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
