const mongoose = require("mongoose");
const collections = require("../config/collections");
const {
  defaultMikrotikDcBatchConfig,
  sanitizeConfig,
  getConfigDocument,
  generateMikrotikDcBatchReport
} = require("../services/mikrotik-dc-batch.service");
const { writeAuditLog } = require("../services/audit-log.service");

exports.getMikrotikDcBatchConfig = async (_req, res) => {
  try {
    const config = await getConfigDocument();
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.saveMikrotikDcBatchConfig = async (req, res) => {
  try {
    const existing = await getConfigDocument();
    const nextConfig = sanitizeConfig({
      ...existing,
      Name: String(
        req.body.Name || existing.Name || defaultMikrotikDcBatchConfig().Name
      ).trim(),
      SendTime: String(
        req.body.SendTime || existing.SendTime || defaultMikrotikDcBatchConfig().SendTime
      ).trim(),
      DisconnectedPlanName: String(
        req.body.DisconnectedPlanName ||
          existing.DisconnectedPlanName ||
          defaultMikrotikDcBatchConfig().DisconnectedPlanName
      ).trim(),
      IsActive: Boolean(req.body.IsActive),
      updatedAt: new Date()
    });

    const collection = mongoose.connection.db.collection(collections.mikrotikDcBatch);
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
      module: "MIKROTIK_DC_BATCH",
      action: "SAVE_CONFIG",
      targetType: "MIKROTIK_DC_BATCH",
      status: "SUCCESS",
      summary: "MikroTik DC batch configuration saved.",
      values: nextConfig
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.previewMikrotikDcBatch = async (req, res) => {
  try {
    const report = await generateMikrotikDcBatchReport({ applyChanges: false });

    await writeAuditLog({
      req,
      module: "MIKROTIK_DC_BATCH",
      action: "PREVIEW_REPORT",
      targetType: "MIKROTIK_DC_BATCH",
      status: "SUCCESS",
      summary: "MikroTik DC batch preview generated.",
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

exports.runMikrotikDcBatchNow = async (req, res) => {
  try {
    const triggeredBy = String(
      req.user?.name || req.user?.username || req.user?.type || ""
    ).trim();
    const report = await generateMikrotikDcBatchReport({
      applyChanges: true,
      triggeredBy
    });
    const config = await getConfigDocument();

    res.json({
      report,
      config,
      reason: `MikroTik DC batch finished. Updated ${report?.summary?.updatedCount || 0} client(s).`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
