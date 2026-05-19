const mongoose = require("mongoose");
const { ObjectId } = mongoose.Types;
const collections = require("../config/collections");

const normalizeAccountName = (value) =>
  String(value || "")
    .trim()
    .toUpperCase();

const normalizeAccountNumber = (value) =>
  String(value || "")
    .replace(/\s+/g, "")
    .trim();

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

exports.getClientBypassClients = async (_req, res) => {
  try {
    const db = mongoose.connection.db;
    const [clients, bypassRows] = await Promise.all([
      db
        .collection(collections.clients)
        .find(
          {},
          {
            projection: {
              AccountName: 1,
              AccountNumber: 1,
              AuthenticationMode: 1,
              ClientName: 1,
              MacAddress: 1,
              macAddress: 1
            }
          }
        )
        .sort({ AccountName: 1, ClientName: 1 })
        .toArray(),
      db.collection(collections.clientBypass).find({}).toArray()
    ]);
    const bypassAccountKeys = new Set(
      (bypassRows || [])
        .map((row) => normalizeAccountName(row.AccountNameKey || row.AccountName))
        .filter(Boolean)
    );
    const bypassAccountNumbers = new Set(
      (bypassRows || [])
        .map((row) => normalizeAccountNumber(row.AccountNumberKey || row.AccountNumber))
        .filter(Boolean)
    );
    const bypassClientIds = new Set(
      (bypassRows || [])
        .map((row) => String(row.ClientId || "").trim())
        .filter(Boolean)
    );
    const rows = (clients || []).filter((client) => {
      const authMode = String(client.AuthenticationMode || "").trim().toUpperCase();
      const accountKey = normalizeAccountName(client.AccountName);
      const accountNumber = normalizeAccountNumber(client.AccountNumber);
      const clientId = String(client._id || "").trim();

      return (
        ["IPOE", "PPPOE"].includes(authMode) &&
        !(accountKey && bypassAccountKeys.has(accountKey)) &&
        !(accountNumber && bypassAccountNumbers.has(accountNumber)) &&
        !(clientId && bypassClientIds.has(clientId))
      );
    });

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
      AccountNumber: client.AccountNumber || "",
      AccountNumberKey: normalizeAccountNumber(client.AccountNumber),
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
