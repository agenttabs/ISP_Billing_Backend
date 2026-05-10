const mongoose = require("mongoose");
const collections = require("../config/collections");
const { writeAuditLog } = require("../services/audit-log.service");
const {
  defaultEmailNotificationConfig,
  getEmailReadyClients,
  getGmailDefaults,
  getConfigDocument,
  getEligibleClients,
  sanitizeConfig,
  sendBillingEmails
} = require("../services/email-notification.service");

const mapEligibleClients = (clients = []) =>
  clients.map((client) => ({
    _id: client?._id,
    AccountName: client?.AccountName || "",
    ClientName: client?.ClientName || "",
    AccountNumber: client?.AccountNumber || "",
    Email: client?.Email || "",
    DueDate: client?.DueDate || null,
    EmailBillingEnabled: Boolean(client?.EmailBillingEnabled)
  }));

const mapAvailableClients = (clients = []) =>
  clients.map((client) => ({
    _id: client?._id,
    AccountName: client?.AccountName || "",
    ClientName: client?.ClientName || "",
    AccountNumber: client?.AccountNumber || "",
    Email: client?.Email || "",
    DueDate: client?.DueDate || null
  }));

exports.getEmailNotificationConfig = async (_req, res) => {
  try {
    const config = await getConfigDocument();
    const eligibleClients = await getEligibleClients(config.DaysOffset);
    const availableClients = await getEmailReadyClients();

    res.json({
      ...sanitizeConfig(config),
      EligibleCount: eligibleClients.length,
      EligibleClients: mapEligibleClients(eligibleClients),
      AvailableClients: mapAvailableClients(availableClients)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.saveEmailNotificationConfig = async (req, res) => {
  try {
    const existing = await getConfigDocument();
    const gmailDefaults = await getGmailDefaults();
    const defaults = {
      ...defaultEmailNotificationConfig(),
      ...gmailDefaults
    };
    const nextConfig = sanitizeConfig({
      ...existing,
      ...defaults,
      Name: String(req.body.Name || defaults.Name).trim(),
      DaysOffset: Number(req.body.DaysOffset || 0),
      SendTime: String(req.body.SendTime || defaults.SendTime).trim(),
      Subject: String(req.body.Subject || defaults.Subject),
      Body: String(req.body.Body || defaults.Body),
      SmtpHost: String(req.body.SmtpHost || "").trim(),
      SmtpPort: Number(req.body.SmtpPort || defaults.SmtpPort),
      SmtpSecure: Boolean(req.body.SmtpSecure),
      SmtpUser: String(req.body.SmtpUser || "").trim(),
      SmtpPassword: String(req.body.SmtpPassword || ""),
      FromName: String(req.body.FromName || defaults.FromName).trim(),
      IsActive: Boolean(req.body.IsActive),
      ManualClientIds: Array.isArray(req.body.ManualClientIds)
        ? req.body.ManualClientIds
        : [],
      updatedAt: new Date()
    }, defaults);

    const collection = mongoose.connection.db.collection(collections.emailNotification);
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

    const eligibleClients = await getEligibleClients(nextConfig.DaysOffset);
    const availableClients = await getEmailReadyClients();

    res.json({
      ...nextConfig,
      EligibleCount: eligibleClients.length,
      EligibleClients: mapEligibleClients(eligibleClients),
      AvailableClients: mapAvailableClients(availableClients)
    });

    await writeAuditLog({
      req,
      module: "EMAIL",
      action: "SAVE_NOTIFICATION_CONFIG",
      targetType: "EMAIL_NOTIFICATION",
      status: "SUCCESS",
      summary: "Email notification configuration saved.",
      values: {
        Name: nextConfig.Name,
        DaysOffset: nextConfig.DaysOffset,
        SendTime: nextConfig.SendTime,
        IsActive: nextConfig.IsActive,
        Subject: nextConfig.Subject,
        FromName: nextConfig.FromName,
        ManualClientIds: nextConfig.ManualClientIds
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.runEmailNotificationNow = async (req, res) => {
  try {
    const triggeredBy = String(
      req.user?.name || req.user?.username || req.user?.type || ""
    ).trim();
    const result = await sendBillingEmails({
      force: true,
      triggeredBy,
      manualClientIds: Array.isArray(req.body?.ManualClientIds)
        ? req.body.ManualClientIds
        : undefined
    });
    const config = await getConfigDocument();
    const eligibleClients = await getEligibleClients(config.DaysOffset);
    const availableClients = await getEmailReadyClients();

    res.json({
      ...result,
      config: {
        ...config,
        EligibleCount: eligibleClients.length,
        EligibleClients: mapEligibleClients(eligibleClients),
        AvailableClients: mapAvailableClients(availableClients)
      }
    });

    await writeAuditLog({
      req,
      module: "EMAIL",
      action: "RUN_NOTIFICATION_NOW",
      targetType: "EMAIL_NOTIFICATION",
      status: "SUCCESS",
      summary: "Billing email notification run executed.",
      details: result
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
