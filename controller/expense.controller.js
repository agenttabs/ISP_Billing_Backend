const mongoose = require("mongoose");
const { ObjectId } = mongoose.Types;
const collections = require("../config/collections");
const { writeAuditLog } = require("../services/audit-log.service");

const normalizeAmount = (value) =>
  String(value ?? "")
    .replace(/,/g, "")
    .replace(/[^0-9.\-]/g, "")
    .trim();

const formatLogDate = (value) => {
  if (!value) {
    const now = new Date();
    return `${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()}`;
  }

  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) {
    return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
  }

  const plain = String(value).trim();
  if (/^\d{4}\/\d{1,2}\/\d{1,2}$/.test(plain)) {
    return plain;
  }

  return plain;
};

const buildExpensePayload = (body, req) => ({
  Name: String(body?.Name || "").trim(),
  Type: String(body?.Type || "").trim(),
  Amount: normalizeAmount(body?.Amount),
  Invoice: String(body?.Invoice || "").trim(),
  LogDate: formatLogDate(body?.LogDate),
  Docs: String(body?.Docs || "").trim(),
  InCharge: String(
    body?.InCharge ||
      req?.user?.username ||
      req?.user?.Username ||
      req?.user?.name ||
      req?.user?.Name ||
      "admin"
  ).trim()
});

exports.getExpenses = async (_req, res) => {
  try {
    const rows = await mongoose.connection.db
      .collection(collections.expense)
      .find({})
      .sort({ createdAt: -1, LogDate: -1 })
      .toArray();

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.createExpense = async (req, res) => {
  try {
    const payload = {
      ...buildExpensePayload(req.body, req),
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const result = await mongoose.connection.db
      .collection(collections.expense)
      .insertOne(payload);

    const savedRow = {
      _id: result.insertedId,
      ...payload
    };

    res.status(201).json(savedRow);

    await writeAuditLog({
      req,
      module: "EXPENSE",
      action: "CREATE",
      targetType: "EXPENSE",
      targetId: result.insertedId,
      status: "SUCCESS",
      summary: "Expense record created.",
      values: payload
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.updateExpense = async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid expense id." });
    }

    const existing = await mongoose.connection.db
      .collection(collections.expense)
      .findOne({ _id: new ObjectId(id) });

    if (!existing) {
      return res.status(404).json({ error: "Expense not found." });
    }

    const payload = {
      ...buildExpensePayload(req.body, req),
      updatedAt: new Date()
    };

    await mongoose.connection.db
      .collection(collections.expense)
      .updateOne({ _id: new ObjectId(id) }, { $set: payload });

    res.json({
      _id: id,
      ...existing,
      ...payload
    });

    await writeAuditLog({
      req,
      module: "EXPENSE",
      action: "UPDATE",
      targetType: "EXPENSE",
      targetId: id,
      status: "SUCCESS",
      summary: "Expense record updated.",
      values: payload
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.deleteExpense = async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid expense id." });
    }

    const existing = await mongoose.connection.db
      .collection(collections.expense)
      .findOne({ _id: new ObjectId(id) });

    if (!existing) {
      return res.status(404).json({ error: "Expense not found." });
    }

    await mongoose.connection.db
      .collection(collections.expense)
      .deleteOne({ _id: new ObjectId(id) });

    res.json({ success: true });

    await writeAuditLog({
      req,
      module: "EXPENSE",
      action: "DELETE",
      targetType: "EXPENSE",
      targetId: id,
      status: "SUCCESS",
      summary: "Expense record deleted.",
      values: existing
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
