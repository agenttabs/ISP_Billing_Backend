const mongoose = require("mongoose");
const collections = require("../config/collections");
const { writeAuditLog } = require("../services/audit-log.service");

const sanitizeBatchProgram = (program) => ({
  _id: program._id,
  Name: String(program.Name || "").trim(),
  TemplateType: String(program.TemplateType || "").trim(),
  RecipientRule: String(program.RecipientRule || "DUE_DATE").trim().toUpperCase(),
  DaysOffset: Number(program.DaysOffset || 0),
  SendTime: String(program.SendTime || "").trim(),
  Body: String(program.Body || ""),
  IsActive: Boolean(program.IsActive)
});

exports.getSmsBatchPrograms = async (_req, res) => {
  try {
    const programs = await mongoose.connection.db
      .collection(collections.smsBatchProgram)
      .find({})
      .sort({ createdAt: -1 })
      .toArray();

    res.json(programs.map(sanitizeBatchProgram));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.createSmsBatchProgram = async (req, res) => {
  try {
    const Name = String(req.body.Name || "").trim();
    const TemplateType = String(req.body.TemplateType || "").trim();
    const RecipientRule = String(req.body.RecipientRule || "DUE_DATE")
      .trim()
      .toUpperCase();
    const DaysOffset = Number(req.body.DaysOffset || 0);
    const SendTime = String(req.body.SendTime || "").trim();
    const Body = String(req.body.Body || "");
    const IsActive = Boolean(req.body.IsActive);

    if (!Name || !TemplateType || !Body.trim() || !SendTime) {
      return res.status(400).json({
        error: "Name, TemplateType, SendTime, and Body are required."
      });
    }

    const collection = mongoose.connection.db.collection(collections.smsBatchProgram);
    const duplicate = await collection.findOne({
      Name: { $regex: new RegExp(`^${Name}$`, "i") }
    });

    if (duplicate) {
      return res.status(409).json({
        error: "A batch program with this name already exists."
      });
    }

    const payload = {
      Name,
      TemplateType,
      RecipientRule,
      DaysOffset,
      SendTime,
      Body,
      IsActive,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const result = await collection.insertOne(payload);

    res.status(201).json({
      ...sanitizeBatchProgram(payload),
      _id: result.insertedId
    });

    await writeAuditLog({
      req,
      module: "SMS_BATCH",
      action: "CREATE_PROGRAM",
      targetType: "SMS_BATCH_PROGRAM",
      targetId: result.insertedId,
      status: "SUCCESS",
      summary: "SMS batch program created.",
      values: sanitizeBatchProgram(payload)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.updateSmsBatchProgram = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid batch program id." });
    }

    const Name = String(req.body.Name || "").trim();
    const TemplateType = String(req.body.TemplateType || "").trim();
    const RecipientRule = String(req.body.RecipientRule || "DUE_DATE")
      .trim()
      .toUpperCase();
    const DaysOffset = Number(req.body.DaysOffset || 0);
    const SendTime = String(req.body.SendTime || "").trim();
    const Body = String(req.body.Body || "");
    const IsActive = Boolean(req.body.IsActive);

    if (!Name || !TemplateType || !Body.trim() || !SendTime) {
      return res.status(400).json({
        error: "Name, TemplateType, SendTime, and Body are required."
      });
    }

    const collection = mongoose.connection.db.collection(collections.smsBatchProgram);
    const objectId = new mongoose.Types.ObjectId(id);
    const duplicate = await collection.findOne({
      _id: { $ne: objectId },
      Name: { $regex: new RegExp(`^${Name}$`, "i") }
    });

    if (duplicate) {
      return res.status(409).json({
        error: "Another batch program already uses this name."
      });
    }

    const result = await collection.findOneAndUpdate(
      { _id: objectId },
      {
        $set: {
          Name,
          TemplateType,
          RecipientRule,
          DaysOffset,
          SendTime,
          Body,
          IsActive,
          updatedAt: new Date()
        }
      },
      { returnDocument: "after" }
    );

    if (!result.value) {
      return res.status(404).json({ error: "Batch program not found." });
    }

    res.json(sanitizeBatchProgram(result.value));

    await writeAuditLog({
      req,
      module: "SMS_BATCH",
      action: "UPDATE_PROGRAM",
      targetType: "SMS_BATCH_PROGRAM",
      targetId: id,
      status: "SUCCESS",
      summary: "SMS batch program updated.",
      values: sanitizeBatchProgram(result.value)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
