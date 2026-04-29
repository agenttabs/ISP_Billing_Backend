const mongoose = require("mongoose");
const { ObjectId } = mongoose.Types;
const collections = require("../config/collections");
const { writeAuditLog } = require("../services/audit-log.service");

const cleanString = (value) => String(value || "").trim();
const normalizeCoordinate = (value) =>
  String(value ?? "")
    .replace(/[^0-9.\-]/g, "")
    .trim();

const buildNapPayload = (body, req) => ({
  Name: cleanString(body?.Name),
  NapCode: cleanString(body?.NapCode || body?.Code),
  Address: cleanString(body?.Address),
  Latitude: normalizeCoordinate(body?.Latitude),
  Longitude: normalizeCoordinate(body?.Longitude),
  Notes: cleanString(body?.Notes),
  FiberLine: cleanString(body?.FiberLine),
  Status: cleanString(body?.Status || "ACTIVE") || "ACTIVE",
  InCharge: cleanString(
    body?.InCharge ||
      req?.user?.username ||
      req?.user?.Username ||
      req?.user?.name ||
      req?.user?.Name
  )
});

exports.getNapList = async (_req, res) => {
  try {
    const rows = await mongoose.connection.db
      .collection(collections.nap)
      .find({})
      .sort({ createdAt: -1, Name: 1 })
      .toArray();

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.createNap = async (req, res) => {
  try {
    const payload = {
      ...buildNapPayload(req.body, req),
      createdAt: new Date(),
      updatedAt: new Date()
    };

    if (!payload.Name) {
      return res.status(400).json({ error: "NAP name is required." });
    }

    const result = await mongoose.connection.db
      .collection(collections.nap)
      .insertOne(payload);

    res.status(201).json({
      _id: result.insertedId,
      ...payload
    });

    await writeAuditLog({
      req,
      module: "NAP",
      action: "CREATE",
      targetType: "NAP",
      targetId: result.insertedId,
      status: "SUCCESS",
      summary: "NAP location created.",
      values: payload
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.updateNap = async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid NAP id." });
    }

    const existing = await mongoose.connection.db
      .collection(collections.nap)
      .findOne({ _id: new ObjectId(id) });

    if (!existing) {
      return res.status(404).json({ error: "NAP location not found." });
    }

    const payload = {
      ...buildNapPayload(req.body, req),
      updatedAt: new Date()
    };

    if (!payload.Name) {
      return res.status(400).json({ error: "NAP name is required." });
    }

    await mongoose.connection.db
      .collection(collections.nap)
      .updateOne({ _id: new ObjectId(id) }, { $set: payload });

    res.json({
      _id: id,
      ...existing,
      ...payload
    });

    await writeAuditLog({
      req,
      module: "NAP",
      action: "UPDATE",
      targetType: "NAP",
      targetId: id,
      status: "SUCCESS",
      summary: "NAP location updated.",
      values: payload
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.deleteNap = async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid NAP id." });
    }

    const existing = await mongoose.connection.db
      .collection(collections.nap)
      .findOne({ _id: new ObjectId(id) });

    if (!existing) {
      return res.status(404).json({ error: "NAP location not found." });
    }

    await mongoose.connection.db
      .collection(collections.nap)
      .deleteOne({ _id: new ObjectId(id) });

    res.json({ success: true });

    await writeAuditLog({
      req,
      module: "NAP",
      action: "DELETE",
      targetType: "NAP",
      targetId: id,
      status: "SUCCESS",
      summary: "NAP location deleted.",
      values: existing
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
