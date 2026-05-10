const mongoose = require("mongoose");
const { ObjectId } = mongoose.Types;
const collections = require("../config/collections");
const { writeAuditLog } = require("../services/audit-log.service");

const cleanString = (value) => String(value || "").trim();
const normalizeAmount = (value) =>
  Number(String(value ?? "").replace(/,/g, "").trim()) || 0;

const buildNetPlanPayload = (body) => ({
  Name: cleanString(body?.Name || body?.name),
  Speed: cleanString(body?.Speed || body?.speed),
  Price: normalizeAmount(body?.Price || body?.price),
  TYPE: cleanString(body?.TYPE || body?.Type || body?.type),
  Rx: cleanString(body?.Rx || body?.rx),
  Tx: cleanString(body?.Tx || body?.tx)
});

exports.createNetPlan = async (req, res) => {
  try {
    const payload = {
      ...buildNetPlanPayload(req.body),
      createdAt: new Date(),
      updatedAt: new Date()
    };

    if (!payload.Name) {
      return res.status(400).json({ error: "Netplan name is required." });
    }

    const result = await mongoose.connection.db
      .collection(collections.netPlans)
      .insertOne(payload);

    res.status(201).json({
      _id: result.insertedId,
      ...payload
    });

    await writeAuditLog({
      req,
      module: "NETPLAN",
      action: "CREATE",
      targetType: "NETPLAN",
      targetId: result.insertedId,
      status: "SUCCESS",
      summary: "Netplan created.",
      values: payload
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.updateNetPlan = async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid netplan id." });
    }

    const existing = await mongoose.connection.db
      .collection(collections.netPlans)
      .findOne({ _id: new ObjectId(id) });

    if (!existing) {
      return res.status(404).json({ error: "Netplan not found." });
    }

    const payload = {
      ...buildNetPlanPayload(req.body),
      updatedAt: new Date()
    };

    if (!payload.Name) {
      return res.status(400).json({ error: "Netplan name is required." });
    }

    await mongoose.connection.db
      .collection(collections.netPlans)
      .updateOne({ _id: new ObjectId(id) }, { $set: payload });

    res.json({
      _id: id,
      ...existing,
      ...payload
    });

    await writeAuditLog({
      req,
      module: "NETPLAN",
      action: "UPDATE",
      targetType: "NETPLAN",
      targetId: id,
      status: "SUCCESS",
      summary: "Netplan updated.",
      values: payload
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.deleteNetPlan = async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid netplan id." });
    }

    const existing = await mongoose.connection.db
      .collection(collections.netPlans)
      .findOne({ _id: new ObjectId(id) });

    if (!existing) {
      return res.status(404).json({ error: "Netplan not found." });
    }

    await mongoose.connection.db
      .collection(collections.netPlans)
      .deleteOne({ _id: new ObjectId(id) });

    res.json({ success: true });

    await writeAuditLog({
      req,
      module: "NETPLAN",
      action: "DELETE",
      targetType: "NETPLAN",
      targetId: id,
      status: "SUCCESS",
      summary: "Netplan deleted.",
      values: existing
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
