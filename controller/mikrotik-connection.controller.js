const mongoose = require("mongoose");
const collections = require("../config/collections");
const { testMikrotikConnection } = require("../services/mikrotik");
const { writeAuditLog } = require("../services/audit-log.service");

const normalizeServerType = (value) => String(value || "AC").trim().toUpperCase() || "AC";
const normalizePort = (value) => {
  const parsed = Number(String(value || "").trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 8728;
};
const createObjectId = (value) => {
  const normalized = String(value || "").trim();
  if (!normalized || !mongoose.Types.ObjectId.isValid(normalized)) {
    return null;
  }

  return new mongoose.Types.ObjectId(normalized);
};

const sanitizeServer = (row = {}) => ({
  _id: row._id,
  Name: String(row.Name || "").trim(),
  ServerType: normalizeServerType(row.ServerType),
  Address: String(row.Address || "").trim(),
  User: String(row.User || "").trim(),
  Password: row.Password ? "***" : "",
  HasPassword: Boolean(row.Password),
  Port: normalizePort(row.Port),
  Notes: String(row.Notes || "").trim(),
  IsDefault: Boolean(row.IsDefault)
});

const getCollection = () => mongoose.connection.db.collection(collections.servers);

exports.getMikrotikConnections = async (_req, res) => {
  try {
    const rows = await getCollection()
      .find({ ServerType: { $regex: /^AC$/i } })
      .sort({ IsDefault: -1, Name: 1, Address: 1 })
      .toArray();

    res.json(rows.map(sanitizeServer));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.saveMikrotikConnection = async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const objectId = id ? createObjectId(id) : null;

    if (id && !objectId) {
      return res.status(400).json({ error: "Invalid MikroTik connection id." });
    }

    const existing = objectId ? await getCollection().findOne({ _id: objectId }) : null;

    const payload = {
      Name: String(req.body.Name || existing?.Name || "").trim(),
      ServerType: "AC",
      Address: String(req.body.Address || existing?.Address || "").trim(),
      User: String(req.body.User || existing?.User || "").trim(),
      Password: String(req.body.Password || "").trim() || String(existing?.Password || "").trim(),
      Port: normalizePort(req.body.Port ?? existing?.Port),
      Notes: String(req.body.Notes || existing?.Notes || "").trim(),
      IsDefault: Boolean(req.body.IsDefault)
    };

    if (!payload.Name || !payload.Address || !payload.User || !payload.Password) {
      return res.status(400).json({ error: "Name, address, user, and password are required." });
    }

    if (payload.IsDefault) {
      await getCollection().updateMany(
        { ServerType: { $regex: /^AC$/i }, ...(objectId ? { _id: { $ne: objectId } } : {}) },
        { $set: { IsDefault: false } }
      );
    }

    let saved;
    if (existing?._id) {
      await getCollection().updateOne({ _id: existing._id }, { $set: payload });
      saved = await getCollection().findOne({ _id: existing._id });
    } else {
      const result = await getCollection().insertOne({
        ...payload,
        createdAt: new Date()
      });
      saved = await getCollection().findOne({ _id: result.insertedId });
    }

    res.json(sanitizeServer(saved));

    await writeAuditLog({
      req,
      module: "MIKROTIK_CONNECTION",
      action: existing?._id ? "UPDATE" : "CREATE",
      targetType: "MIKROTIK_SERVER",
      targetId: String(saved?._id || ""),
      status: "SUCCESS",
      summary: existing?._id ? "Mikrotik connection updated." : "Mikrotik connection created.",
      values: sanitizeServer(saved)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.deleteMikrotikConnection = async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) {
      return res.status(400).json({ error: "Connection id is required." });
    }

    const objectId = createObjectId(id);
    if (!objectId) {
      return res.status(400).json({ error: "Invalid MikroTik connection id." });
    }

    const existing = await getCollection().findOne({ _id: objectId });
    if (!existing) {
      return res.status(404).json({ error: "Mikrotik connection not found." });
    }

    await getCollection().deleteOne({ _id: existing._id });
    res.json({ success: true });

    await writeAuditLog({
      req,
      module: "MIKROTIK_CONNECTION",
      action: "DELETE",
      targetType: "MIKROTIK_SERVER",
      targetId: String(existing._id || ""),
      status: "SUCCESS",
      summary: "Mikrotik connection deleted.",
      values: sanitizeServer(existing)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.testMikrotikConnection = async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    let config;

    if (id) {
      const objectId = createObjectId(id);
      if (!objectId) {
        return res.status(400).json({ error: "Invalid MikroTik connection id." });
      }

      const existing = await getCollection().findOne({ _id: objectId });
      if (!existing) {
        return res.status(404).json({ error: "Mikrotik connection not found." });
      }

      config = {
        Address: existing.Address,
        User: existing.User,
        Password: existing.Password,
        Port: existing.Port
      };
    } else {
      config = {
        Address: String(req.body.Address || "").trim(),
        User: String(req.body.User || "").trim(),
        Password: String(req.body.Password || "").trim(),
        Port: normalizePort(req.body.Port)
      };
    }

    if (!config.Address || !config.User || !config.Password) {
      return res.status(400).json({ error: "Address, user, and password are required for connection test." });
    }

    const result = await testMikrotikConnection(config);
    res.json(result);

    await writeAuditLog({
      req,
      module: "MIKROTIK_CONNECTION",
      action: "TEST",
      targetType: "MIKROTIK_SERVER",
      targetId: id,
      status: "SUCCESS",
      summary: "Mikrotik connection test succeeded.",
      details: result
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
