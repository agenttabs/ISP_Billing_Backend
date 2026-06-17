const mongoose = require("mongoose");
const collections = require("../config/collections");
const { writeAuditLog } = require("../services/audit-log.service");

const normalizeStatus = (value) => {
  const status = String(value || "PENDING").trim().toUpperCase();
  if (status === "CANCEL" || status === "CANCELLED") {
    return "CANCEL";
  }

  return status === "DONE" ? "DONE" : "PENDING";
};

const getCollection = () => mongoose.connection.db.collection(collections.installations);

exports.getInstallations = async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    const status = String(req.query.status || "ALL").trim().toUpperCase();
    const filter = {};

    if (status !== "ALL") {
      filter.Status = normalizeStatus(status);
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

    if (id) {
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ error: "Invalid installation id." });
      }

      await getCollection().updateOne(
        { _id: new mongoose.Types.ObjectId(id) },
        { $set: payload }
      );
    } else {
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
