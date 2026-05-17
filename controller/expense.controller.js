const mongoose = require("mongoose");
const { ObjectId } = mongoose.Types;
const collections = require("../config/collections");
const { writeAuditLog } = require("../services/audit-log.service");
const APP_TIME_ZONE = process.env.APP_TIME_ZONE || "Asia/Manila";

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

  const isoDate = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
    const [year, month, day] = isoDate.split("-");
    return `${Number(year)}/${Number(month)}/${Number(day)}`;
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

const getTodayLogDate = () => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: APP_TIME_ZONE,
    year: "numeric",
    month: "numeric",
    day: "numeric"
  }).formatToParts(new Date());

  const dateParts = Object.fromEntries(
    parts
      .filter((part) => ["year", "month", "day"].includes(part.type))
      .map((part) => [part.type, part.value])
  );

  return `${dateParts.year}/${dateParts.month}/${dateParts.day}`;
};

const getActor = (req) => ({
  id: String(req?.user?.id || req?.user?._id || "").trim(),
  username: String(req?.user?.username || req?.user?.Username || "").trim(),
  name: String(req?.user?.name || req?.user?.Name || "").trim(),
  type: String(req?.user?.type || req?.user?.Type || "").trim().toUpperCase()
});

const getActorDisplay = (actor) =>
  actor.name || actor.username || actor.id || "admin";

const buildCashierExpenseFilter = (req) => {
  const actor = getActor(req);

  if (actor.type !== "CASHIER") {
    return {};
  }

  const ownerValues = [actor.id, actor.username, actor.name].filter(Boolean);
  if (!ownerValues.length) {
    return { _id: null };
  }

  return {
    $or: [
      { InChargeId: { $in: ownerValues } },
      { InCharge: { $in: ownerValues } },
      { CreatedById: { $in: ownerValues } },
      { CreatedBy: { $in: ownerValues } }
    ],
    LogDate: getTodayLogDate()
  };
};

const canCashierAccessExpense = (existing, actor) => {
  const ownerValues = [actor.id, actor.username, actor.name].filter(Boolean);
  const existingOwnerValues = [
    existing.InChargeId,
    existing.InCharge,
    existing.CreatedById,
    existing.CreatedBy
  ].map((value) => String(value || "").trim());

  return (
    existingOwnerValues.some((value) => ownerValues.includes(value)) &&
    String(existing.LogDate || "").trim() === getTodayLogDate()
  );
};

const buildExpensePayload = (body, req) => {
  const actor = getActor(req);
  const actorDisplay = getActorDisplay(actor);
  const isCashier = actor.type === "CASHIER";

  return {
    Name: String(body?.Name || "").trim(),
    Type: String(body?.Type || "").trim(),
    Amount: normalizeAmount(body?.Amount),
    Invoice: String(body?.Invoice || "").trim(),
    LogDate: isCashier ? getTodayLogDate() : formatLogDate(body?.LogDate),
    Docs: String(body?.Docs || "").trim(),
    InCharge: actorDisplay,
    InChargeId: actor.id,
    CreatedBy: actorDisplay,
    CreatedById: actor.id
  };
};

exports.getExpenses = async (req, res) => {
  try {
    const rows = await mongoose.connection.db
      .collection(collections.expense)
      .find(buildCashierExpenseFilter(req))
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

    const actor = getActor(req);
    if (actor.type === "CASHIER") {
      if (!canCashierAccessExpense(existing, actor)) {
        return res.status(403).json({
          error: "Cashier can only update today's own expenses."
        });
      }
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
