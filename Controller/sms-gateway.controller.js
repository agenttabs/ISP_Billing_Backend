const mongoose = require("mongoose");
const collections = require("../config/collections");
const { writeAuditLog } = require("../services/audit-log.service");
const { sendDirectSmsWithGateway } = require("../services/sms.service");

const getSmsGatewayCollection = () => {
  const db = mongoose.connection.db;
  const collectionName =
    Array.isArray(collections.smsGatewayCandidates) &&
    collections.smsGatewayCandidates.length > 0
      ? collections.smsGatewayCandidates[0]
      : "SmsGateway";

  return {
    db,
    collectionName,
    collection: db.collection(collectionName)
  };
};

const sanitizeGateway = (row) => ({
  _id: row._id,
  ServiceName: String(row.ServiceName || row.serviceName || "").trim(),
  Status: String(row.Status || row.status || "").trim(),
  ApiUrl: String(row.ApiUrl || row.apiUrl || row.URL || row.url || "").trim(),
  Secret: String(row.Secret || row.secret || "").trim(),
  Mode: String(row.Mode || row.mode || "").trim(),
  Device: String(row.Device || row.device || "").trim(),
  Sim: String(row.Sim || row.sim || "").trim()
});

exports.getSmsGateways = async (_req, res) => {
  try {
    const { collection, collectionName } = getSmsGatewayCollection();
    const rows = await collection.find({}).sort({ ServiceName: 1 }).toArray();

    res.json({
      collectionName,
      rows: rows.map(sanitizeGateway)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.createSmsGateway = async (req, res) => {
  try {
    const { collection, collectionName } = getSmsGatewayCollection();
    const ServiceName = String(req.body.ServiceName || "").trim();
    const Status = String(req.body.Status || "").trim().toUpperCase() || "NO";
    const ApiUrl = String(req.body.ApiUrl || req.body.URL || "").trim();
    const Secret = String(req.body.Secret || "").trim();
    const Mode = String(req.body.Mode || "").trim() || "devices";
    const Device = String(req.body.Device || req.body.Sim || "").trim();
    const Sim = String(req.body.Sim || "").trim() || "1";

    if (!ServiceName) {
      return res.status(400).json({ error: "ServiceName is required." });
    }

    const existing = await collection.findOne({
      ServiceName: { $regex: new RegExp(`^${ServiceName}$`, "i") }
    });

    if (existing) {
      return res.status(409).json({ error: "SMS service already exists." });
    }

    const payload = {
      ServiceName,
      Status,
      ApiUrl,
      Secret,
      Mode,
      Device,
      Sim,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const result = await collection.insertOne(payload);
    const responseRow = {
      ...sanitizeGateway(payload),
      _id: result.insertedId
    };

    res.status(201).json({
      collectionName,
      row: responseRow
    });

    await writeAuditLog({
      req,
      module: "SMS_GATEWAY",
      action: "CREATE",
      targetType: "SMS_GATEWAY",
      targetId: result.insertedId,
      status: "SUCCESS",
      summary: "SMS gateway created.",
      values: responseRow
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.updateSmsGateway = async (req, res) => {
  try {
    const { collection, collectionName } = getSmsGatewayCollection();
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid SMS gateway id." });
    }

    const ServiceName = String(req.body.ServiceName || "").trim();
    const Status = String(req.body.Status || "").trim().toUpperCase() || "NO";
    const ApiUrl = String(req.body.ApiUrl || req.body.URL || "").trim();
    const Secret = String(req.body.Secret || "").trim();
    const Mode = String(req.body.Mode || "").trim() || "devices";
    const Device = String(req.body.Device || req.body.Sim || "").trim();
    const Sim = String(req.body.Sim || "").trim() || "1";

    if (!ServiceName) {
      return res.status(400).json({ error: "ServiceName is required." });
    }

    const objectId = new mongoose.Types.ObjectId(id);
    const duplicate = await collection.findOne({
      _id: { $ne: objectId },
      ServiceName: { $regex: new RegExp(`^${ServiceName}$`, "i") }
    });

    if (duplicate) {
      return res.status(409).json({ error: "Another SMS service already uses this name." });
    }

    const updateResult = await collection.updateOne(
      { _id: objectId },
      {
        $set: {
          ServiceName,
          Status,
          ApiUrl,
          Secret,
          Mode,
          Device,
          Sim,
          updatedAt: new Date()
        }
      }
    );

    if (!updateResult.matchedCount) {
      return res.status(404).json({ error: "SMS gateway not found." });
    }

    const updatedRow = await collection.findOne({ _id: objectId });
    const responseRow = sanitizeGateway(updatedRow);

    res.json({
      collectionName,
      row: responseRow
    });

    await writeAuditLog({
      req,
      module: "SMS_GATEWAY",
      action: "UPDATE",
      targetType: "SMS_GATEWAY",
      targetId: id,
      status: "SUCCESS",
      summary: "SMS gateway updated.",
      values: responseRow
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.deleteSmsGateway = async (req, res) => {
  try {
    const { collection, collectionName } = getSmsGatewayCollection();
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid SMS gateway id." });
    }

    const objectId = new mongoose.Types.ObjectId(id);
    const existing = await collection.findOne({ _id: objectId });

    if (!existing) {
      return res.status(404).json({ error: "SMS gateway not found." });
    }

    await collection.deleteOne({ _id: objectId });

    res.json({
      collectionName,
      message: "SMS gateway deleted successfully."
    });

    await writeAuditLog({
      req,
      module: "SMS_GATEWAY",
      action: "DELETE",
      targetType: "SMS_GATEWAY",
      targetId: id,
      status: "SUCCESS",
      summary: "SMS gateway deleted.",
      values: sanitizeGateway(existing)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.testSmsGateway = async (req, res) => {
  try {
    const ServiceName = String(req.body.ServiceName || "").trim() || "ZITASMS";
    const Status = String(req.body.Status || "").trim().toUpperCase() || "YES";
    const ApiUrl = String(req.body.ApiUrl || req.body.URL || "").trim();
    const Secret = String(req.body.Secret || "").trim();
    const Mode = String(req.body.Mode || "").trim() || "devices";
    const Device = String(req.body.Device || req.body.Sim || "").trim();
    const Sim = String(req.body.Sim || "").trim() || "1";
    const phone = String(req.body.Phone || req.body.phone || "").trim();
    const message = String(req.body.Message || req.body.message || "").trim();

    if (!phone) {
      return res.status(400).json({ error: "Test phone number is required." });
    }

    if (!message) {
      return res.status(400).json({ error: "Test message is required." });
    }

    const gateway = { ServiceName, Status, ApiUrl, Secret, Mode, Device, Sim };
    const result = await sendDirectSmsWithGateway({
      recipient: phone,
      message,
      gateway
    });

    if (!result.sent) {
      await writeAuditLog({
        req,
        module: "SMS_GATEWAY",
        action: "TEST",
        targetType: "SMS_GATEWAY",
        status: "FAILED",
        summary: result.reason || "SMS gateway test failed.",
        values: { phone, message, gateway: sanitizeGateway(gateway) }
      });

      return res.status(400).json({
        error: result.reason || "SMS gateway test failed."
      });
    }

    await writeAuditLog({
      req,
      module: "SMS_GATEWAY",
      action: "TEST",
      targetType: "SMS_GATEWAY",
      status: "SUCCESS",
      summary: "SMS gateway test sent successfully.",
      values: { phone, message, gateway: sanitizeGateway(gateway) }
    });

    return res.json({
      message: "Test SMS sent successfully.",
      response: result.response || "",
      parsedResponse: result.parsedResponse || null
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
