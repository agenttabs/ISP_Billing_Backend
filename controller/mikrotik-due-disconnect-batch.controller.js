const mongoose = require("mongoose");
const collections = require("../config/collections");
const {
  defaultMikrotikDueDisconnectBatchConfig,
  sanitizeConfig,
  getConfigDocument,
  generateMikrotikDueDisconnectBatchReport
} = require("../services/mikrotik-due-disconnect-batch.service");
const { writeAuditLog } = require("../services/audit-log.service");

exports.getMikrotikDueDisconnectBatchConfig = async (_req, res) => {
  try {
    const config = await getConfigDocument();
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.saveMikrotikDueDisconnectBatchConfig = async (req, res) => {
  try {
    const existing = await getConfigDocument();
    const nextConfig = sanitizeConfig({
      ...existing,
      Name: String(
        req.body.Name || existing.Name || defaultMikrotikDueDisconnectBatchConfig().Name
      ).trim(),
      SendTime: String(
        req.body.SendTime || existing.SendTime || defaultMikrotikDueDisconnectBatchConfig().SendTime
      ).trim(),
      GraceDays: Number(
        req.body.GraceDays ?? existing.GraceDays ?? defaultMikrotikDueDisconnectBatchConfig().GraceDays
      ),
      DisconnectedPlanName: String(
        req.body.DisconnectedPlanName ||
          existing.DisconnectedPlanName ||
          defaultMikrotikDueDisconnectBatchConfig().DisconnectedPlanName
      ).trim(),
      IsActive: Boolean(req.body.IsActive),
      updatedAt: new Date()
    });

    const collection = mongoose.connection.db.collection(collections.mikrotikDueDisconnectBatch);
    const current = await collection.findOne({});

    if (current?._id) {
      await collection.updateOne(
        { _id: current._id },
        {
          $set: {
            ...nextConfig,
            updatedAt: new Date()
          }
        }
      );
    } else {
      await collection.insertOne({
        ...nextConfig,
        createdAt: new Date(),
        updatedAt: new Date()
      });
    }

    res.json(nextConfig);

    await writeAuditLog({
      req,
      module: "MIKROTIK_DUE_DISCONNECT_BATCH",
      action: "SAVE_CONFIG",
      targetType: "MIKROTIK_DUE_DISCONNECT_BATCH",
      status: "SUCCESS",
      summary: "MikroTik due disconnect batch configuration saved.",
      values: nextConfig
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.previewMikrotikDueDisconnectBatch = async (req, res) => {
  try {
    const report = await generateMikrotikDueDisconnectBatchReport({
      applyChanges: false
    });

    await writeAuditLog({
      req,
      module: "MIKROTIK_DUE_DISCONNECT_BATCH",
      action: "PREVIEW_REPORT",
      targetType: "MIKROTIK_DUE_DISCONNECT_BATCH",
      status: "SUCCESS",
      summary: "MikroTik due disconnect preview generated.",
      details: {
        summary: report?.summary || {},
        rowCount: Array.isArray(report?.rows) ? report.rows.length : 0
      }
    });

    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.runMikrotikDueDisconnectBatchNow = async (req, res) => {
  try {
    const triggeredBy = String(
      req.user?.name || req.user?.username || req.user?.type || ""
    ).trim();
    const selectedClientIds = Array.isArray(req.body?.selectedClientIds)
      ? req.body.selectedClientIds
      : [];
    const report = await generateMikrotikDueDisconnectBatchReport({
      applyChanges: true,
      triggeredBy,
      selectedClientIds
    });
    const config = await getConfigDocument();

    res.json({
      report,
      config,
      reason: `Overdue disconnect batch finished. Disconnected ${report?.summary?.updatedCount || 0} client(s).`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
