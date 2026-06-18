const mongoose = require("mongoose");
const collections = require("../config/collections");
const { writeAuditLog } = require("../services/audit-log.service");

const normalizeStatus = (value) => {
  const status = String(value || "PENDING").trim().toUpperCase();
  if (status === "CANCEL" || status === "CANCELLED") {
    return "CANCEL";
  }

  if (status === "ONGOING" || status === "ON GOING") {
    return "ONGOING";
  }

  return status === "DONE" ? "DONE" : "PENDING";
};

const getCollection = () => mongoose.connection.db.collection(collections.installations);

const getLoggedInUser = (req) => ({
  name: String(req.user?.name || req.user?.Name || "").trim(),
  username: String(req.user?.username || req.user?.Username || "").trim(),
  type: String(req.user?.type || req.user?.role || req.user?.Type || "").trim().toUpperCase()
});

const getManilaDateKey = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
};

const normalizeComparable = (value) => String(value || "").trim();

exports.getInstallations = async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    const status = String(req.query.status || "ALL").trim().toUpperCase();
    const user = getLoggedInUser(req);
    const filter = {};

    if (status !== "ALL") {
      filter.Status = normalizeStatus(status);
    }

    if (user.type === "TECHNICIAN") {
      const today = getManilaDateKey();
      filter.InstallationDate = { $regex: `^${today}` };
    }

    if (search) {
      filter.$or = [
        { CustomerName: { $regex: search, $options: "i" } },
        { ContactNumber: { $regex: search, $options: "i" } },
        { Address: { $regex: search, $options: "i" } },
        { Plan: { $regex: search, $options: "i" } }
      ];
    }

    const rows = await getCollection()
      .find(filter)
      .sort({ Status: 1, TransferDate: 1, InstallationDate: -1, createdAt: -1 })
      .toArray();

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.saveInstallation = async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const user = getLoggedInUser(req);
    const payload = {
      CustomerName: String(req.body.CustomerName || "").trim(),
      ContactNumber: String(req.body.ContactNumber || "").trim(),
      Address: String(req.body.Address || "").trim(),
      Plan: String(req.body.Plan || "").trim(),
      InstallationDate: req.body.InstallationDate || "",
      TransferDate: req.body.TransferDate || "",
      Status: normalizeStatus(req.body.Status),
      Note: String(req.body.Note || "").trim(),
      updatedAt: new Date()
    };

    if (!payload.CustomerName) {
      return res.status(400).json({ error: "Customer name is required." });
    }

    let resultId = id;
    let previous = null;

    if (id) {
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ error: "Invalid installation id." });
      }

      previous = await getCollection().findOne({ _id: new mongoose.Types.ObjectId(id) });
      if (!previous) {
        return res.status(404).json({ error: "Installation record not found." });
      }

      const previousStatus = normalizeStatus(previous.Status);
      if (previousStatus === "ONGOING" && !["ONGOING", "DONE", "CANCEL"].includes(payload.Status)) {
        return res.status(403).json({ error: "Ongoing installation can only be changed to Done or Cancel." });
      }

      if (payload.Status === "PENDING" && ["DONE", "CANCEL"].includes(previousStatus) && user.type !== "ADMIN") {
        return res.status(403).json({ error: "Only admin can change Done or Cancel back to Pending." });
      }

      if (user.type === "TECHNICIAN") {
        const lockedFields = ["CustomerName", "ContactNumber", "Address", "Plan", "TransferDate", "Note"];
        const changedLockedField = lockedFields.some(
          (field) => normalizeComparable(payload[field]) !== normalizeComparable(previous[field])
        );

        if (changedLockedField) {
          return res.status(403).json({ error: "Technician can only reschedule installation date or change status." });
        }
      }

      if (payload.Status !== previousStatus) {
        payload.StatusChangedAt = new Date();
        payload.StatusChangedBy = {
          Name: user.name,
          Username: user.username,
          Type: user.type
        };
      }

      await getCollection().updateOne(
        { _id: new mongoose.Types.ObjectId(id) },
        { $set: payload }
      );
    } else {
      payload.StatusChangedAt = new Date();
      payload.StatusChangedBy = {
        Name: user.name,
        Username: user.username,
        Type: user.type
      };

      const result = await getCollection().insertOne({
        ...payload,
        createdAt: new Date()
      });
      resultId = String(result.insertedId);
    }

    const saved = await getCollection().findOne({
      _id: new mongoose.Types.ObjectId(resultId)
    });

    res.json(saved);

    await writeAuditLog({
      req,
      module: "INSTALLATION",
      action: id ? "UPDATE" : "CREATE",
      targetType: "INSTALLATION",
      targetId: resultId,
      accountName: payload.CustomerName,
      status: "SUCCESS",
      summary: id ? "Installation record updated." : "Installation record created.",
      values: payload
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
