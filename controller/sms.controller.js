const mongoose = require("mongoose");
const collections = require("../config/collections");
const { writeAuditLog } = require("../services/audit-log.service");

const sanitizeTemplate = (template) => ({
  _id: template._id,
  TYPE: String(template.TYPE || "").trim(),
  Body: String(template.Body || "")
});

exports.getSmsRecepients = async (_req, res) => {
  try {
    const templates = await mongoose.connection.db
      .collection(collections.smsRecipient)
      .find({})
      .sort({ TYPE: 1 })
      .toArray();

    res.json(templates.map(sanitizeTemplate));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.createSmsRecepient = async (req, res) => {
  try {
    const TYPE = String(req.body.TYPE || "").trim();
    const Body = String(req.body.Body || "");

    if (!TYPE || !Body.trim()) {
      return res.status(400).json({
        error: "TYPE and Body are required."
      });
    }

    const collection = mongoose.connection.db.collection(collections.smsRecipient);
    const existing = await collection.findOne({
      TYPE: { $regex: new RegExp(`^${TYPE}$`, "i") }
    });

    if (existing) {
      return res.status(409).json({
        error: "An SMS template with this TYPE already exists."
      });
    }

    const payload = {
      TYPE,
      Body,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const result = await collection.insertOne(payload);

    res.status(201).json({
      ...sanitizeTemplate(payload),
      _id: result.insertedId
    });

    await writeAuditLog({
      req,
      module: "SMS",
      action: "CREATE_TEMPLATE",
      targetType: "SMS_TEMPLATE",
      targetId: result.insertedId,
      status: "SUCCESS",
      summary: "SMS template created.",
      values: sanitizeTemplate(payload)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.updateSmsRecepient = async (req, res) => {
  try {
    const { id } = req.params;
    const TYPE = String(req.body.TYPE || "").trim();
    const Body = String(req.body.Body || "");

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid template id." });
    }

    if (!TYPE || !Body.trim()) {
      return res.status(400).json({
        error: "TYPE and Body are required."
      });
    }

    const collection = mongoose.connection.db.collection(collections.smsRecipient);
    const objectId = new mongoose.Types.ObjectId(id);
    const duplicate = await collection.findOne({
      _id: { $ne: objectId },
      TYPE: { $regex: new RegExp(`^${TYPE}$`, "i") }
    });

    if (duplicate) {
      return res.status(409).json({
        error: "Another SMS template already uses this TYPE."
      });
    }

    const update = {
      $set: {
        TYPE,
        Body,
        updatedAt: new Date()
      }
    };

    const updateResult = await collection.updateOne(
      { _id: objectId },
      update
    );

    if (!updateResult.matchedCount) {
      return res.status(404).json({ error: "SMS template not found." });
    }

    const updatedTemplate = await collection.findOne({ _id: objectId });

    res.json(sanitizeTemplate(updatedTemplate));

    await writeAuditLog({
      req,
      module: "SMS",
      action: "UPDATE_TEMPLATE",
      targetType: "SMS_TEMPLATE",
      targetId: id,
      status: "SUCCESS",
      summary: "SMS template updated.",
      values: sanitizeTemplate(updatedTemplate)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
