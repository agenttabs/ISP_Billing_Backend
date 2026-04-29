const {
  defaultMikrotikCheckerConfig,
  getConfigDocument,
  generateMikrotikCheckerReport,
  sanitizeConfig,
  sendMikrotikCheckerEmail
} = require("../services/mikrotik-checker.service");
const { writeAuditLog } = require("../services/audit-log.service");

exports.getMikrotikCheckerConfig = async (_req, res) => {
  try {
    const config = await getConfigDocument();
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.saveMikrotikCheckerConfig = async (req, res) => {
  try {
    const existing = await getConfigDocument();
    const nextConfig = sanitizeConfig({
      ...existing,
      Name: String(req.body.Name || existing.Name || defaultMikrotikCheckerConfig().Name).trim(),
      SendTime: String(req.body.SendTime || existing.SendTime || defaultMikrotikCheckerConfig().SendTime).trim(),
      RecipientEmail: String(req.body.RecipientEmail || existing.RecipientEmail || "").trim(),
      IsActive: Boolean(req.body.IsActive),
      updatedAt: new Date()
    }, existing);

    const collection = mongoose.connection.db.collection(collections.mikrotikChecker);
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
      module: "MIKROTIK_CHECKER",
      action: "SAVE_CONFIG",
      targetType: "MIKROTIK_CHECKER",
      status: "SUCCESS",
      summary: "Mikrotik Checker configuration saved.",
      values: nextConfig
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.runMikrotikChecker = async (_req, res) => {
  try {
    const report = await generateMikrotikCheckerReport();
    await writeAuditLog({
      req,
      module: "MIKROTIK_CHECKER",
      action: "GENERATE_REPORT",
      targetType: "MIKROTIK_CHECKER",
      status: "SUCCESS",
      summary: "Mikrotik Checker report generated.",
      details: {
        summary: report?.summary || {},
        issueCount: Array.isArray(report?.issues) ? report.issues.length : 0
      }
    });
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.runMikrotikCheckerEmailNow = async (req, res) => {
  try {
    const triggeredBy = String(
      req.user?.name || req.user?.username || req.user?.type || ""
    ).trim();
    const result = await sendMikrotikCheckerEmail({
      force: true,
      triggeredBy
    });
    const config = await getConfigDocument();

    res.json({
      ...result,
      config
    });

    await writeAuditLog({
      req,
      module: "MIKROTIK_CHECKER",
      action: "RUN_EMAIL_NOW",
      targetType: "MIKROTIK_CHECKER",
      status: "SUCCESS",
      summary: "Mikrotik Checker email run executed.",
      details: result
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
