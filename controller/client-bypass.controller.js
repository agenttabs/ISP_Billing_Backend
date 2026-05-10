const mongoose = require("mongoose");
const { ObjectId } = mongoose.Types;
const collections = require("../config/collections");

const normalizeAccountName = (value) =>
  String(value || "")
    .trim()
    .toUpperCase();

exports.getClientBypassList = async (_req, res) => {
  try {
    const rows = await mongoose.connection.db
      .collection(collections.clientBypass)
      .find({})
      .sort({ createdAt: -1, AccountName: 1 })
      .toArray();

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.createClientBypass = async (req, res) => {
  try {
    const requestedClientId = String(req.body.clientId || req.body.ClientId || "").trim();
    const requestedAccountName = normalizeAccountName(
      req.body.accountName || req.body.AccountName || ""
    );
    const notes = String(req.body.notes || req.body.Notes || "").trim();
    const hasValidClientId = ObjectId.isValid(requestedClientId);

    if (!hasValidClientId && !requestedAccountName) {
      return res.status(400).json({ error: "Select a client account." });
    }

    const client = await mongoose.connection.db
      .collection(collections.clients)
      .findOne({
        $or: [
          ...(hasValidClientId ? [{ _id: new ObjectId(requestedClientId) }] : []),
          ...(requestedAccountName ? [{ AccountName: requestedAccountName }] : [])
        ]
      });

    if (!client) {
      return res.status(404).json({ error: "Client account not found." });
    }

    const createdBy =
      req.user?.name || req.user?.username || req.user?.Name || req.user?.id || "";
    const createdById = req.user?.id || req.user?._id || "";
    const now = new Date();
    const normalizedClientAccount = normalizeAccountName(client.AccountName);

    const existingBypassRow = await mongoose.connection.db
      .collection(collections.clientBypass)
      .findOne({
        AccountNameKey: normalizedClientAccount
      });

    if (existingBypassRow) {
      return res.status(400).json({ error: "Selected client is already in bypass list." });
    }

    const payload = {
      ClientId: client._id,
      ClientName: client.ClientName || "",
      AccountName: client.AccountName || "",
      AccountNameKey: normalizedClientAccount,
      MacAddress: String(client.MacAddress || client.macAddress || "")
        .trim()
        .toUpperCase(),
      Notes: notes,
      CreatedBy: createdBy,
      CreatedById: createdById,
      createdAt: now,
      updatedAt: now
    };

    const result = await mongoose.connection.db
      .collection(collections.clientBypass)
      .insertOne(payload);

    res.status(201).json({
      _id: result.insertedId,
      ...payload
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.deleteClientBypass = async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid bypass record id." });
    }

    const result = await mongoose.connection.db
      .collection(collections.clientBypass)
      .deleteOne({ _id: new ObjectId(id) });

    if (!result.deletedCount) {
      return res.status(404).json({ error: "Bypass record not found." });
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
