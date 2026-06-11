const {
  defaultOltDumpSchedulerConfig,
  sanitizeConfig,
  getConfigDocument,
  saveConfigDocument,
  runOltDumpNow
} = require("../services/olt-dump-scheduler.service");
const { writeAuditLog } = require("../services/audit-log.service");

exports.getOltDumpSchedulerConfig = async (_req, res) => {
  try {
    const config = await getConfigDocument();
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.saveOltDumpSchedulerConfig = async (req, res) => {
  try {
    const existing = await getConfigDocument();
    const defaults = defaultOltDumpSchedulerConfig();
    const nextConfig = sanitizeConfig({
      ...existing,
      Name: String(req.body?.Name || existing.Name || defaults.Name).trim(),
      SendTime: String(req.body?.SendTime || existing.SendTime || defaults.SendTime).trim(),
      ScheduleTimes: Array.isArray(req.body?.ScheduleTimes)
        ? req.body.ScheduleTimes
        : existing.ScheduleTimes || [existing.SendTime || defaults.SendTime],
      IsActive: Boolean(req.body?.IsActive),
      RunGpon: req.body?.RunGpon === undefined ? existing.RunGpon : Boolean(req.body.RunGpon),
      RunEpon: req.body?.RunEpon === undefined ? existing.RunEpon : Boolean(req.body.RunEpon)
    });

    const saved = await saveConfigDocument(nextConfig);

    res.json(saved);

    await writeAuditLog({
      req,
      module: "OLT_DUMP_SCHEDULER",
      action: "SAVE_CONFIG",
      targetType: "OLT_DUMP_SCHEDULER",
      status: "SUCCESS",
      summary: "OLT dump scheduler configuration saved.",
      values: saved
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.runOltDumpNow = async (req, res) => {
  try {
    const triggeredBy = String(
      req.user?.name || req.user?.username || req.user?.type || ""
    ).trim();
    const report = await runOltDumpNow({
      triggeredBy,
      configOverrides: {
        SendTime: req.body?.SendTime,
        ScheduleTimes: req.body?.ScheduleTimes,
        IsActive: req.body?.IsActive,
        RunGpon: req.body?.RunGpon,
        RunEpon: req.body?.RunEpon
      }
    });

    res.json({
      ...report,
      reason: report.summary
    });
  } catch (err) {
    res.status(500).json({
      error: err.message,
      report: err.report || null
    });
  }
};
