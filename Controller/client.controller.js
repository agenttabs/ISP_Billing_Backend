const mongoose = require("mongoose");


const { addPPPoEUser, checkPPPoEUser, updatePPPoEUser, disconnectPPPoEUser } = require("../services/mikrotik");



// ✅ TEST
exports.testAPI = (req, res) => {
  res.send("API WORKING");
};

// ✅ GET CLIENTS
exports.getClients = async (req, res) => {
  try {
    const data = await mongoose.connection.db
      .collection("clients")
      .find({})
      .toArray();

    console.log("✅ DATA COUNT:", data.length);
    res.json(data);
  } catch (err) {
    console.error("❌ QUERY ERROR:", err);
    res.status(500).json({ error: err.message });
  }
};

// ✅ ADD CLIENT
exports.createClient = async (req, res) => {
  try {
    const location = req.body.ServerLocation || "CCR2116";

    // ✅ CHECK DB DUPLICATE
    const existing = await mongoose.connection.db
      .collection("clients")
      .findOne({ AccountName: req.body.AccountName });

    if (existing) {
      return res.status(400).json({
        error: "Account already exists in database"
      });
    }

    // ✅ CHECK MIKROTIK DUPLICATE
    const existsInRouter = await checkPPPoEUser(
      req.body.AccountName,
      location
    );

    if (existsInRouter) {
      return res.status(400).json({
        error: "Account already exists in MikroTik"
      });
    }

    // ✅ PREPARE DATA
    const data = {
      ClientName: req.body.ClientName || "",
      AccountName: req.body.AccountName || "",
      Password: req.body.Password || "",
      Address: req.body.Address || "",
      ContactNumber: req.body.ContactNumber || "",
      AuthenticationMode: req.body.AuthenticationMode || "",
      Profile: req.body.Profile || "",
      NetPlan: req.body.NetPlan || "",
      AmountDue: req.body.AmountDue || 0,
      DueDate: req.body.DueDate || "",
      SubscriptionCover: req.body.SubscriptionCover || "UN-GROUPED",
      Status: "ACTIVE",
      Note: req.body.Note || "",
      AccountNumber: req.body.AccountNumber || "",
      DateEntry: req.body.DateEntry || "",
      Email: "N/A",
      Facebook: "N/A",
      createdAt: new Date(),
      PaymentStatus: "UNPAID",
      ServerLocation: location
    };

    // ✅ SAVE TO DB
    const result = await mongoose.connection.db
      .collection("clients")
      .insertOne(data);

    // ✅ CREATE PPP USER
    await updatePPPoEUser({
      oldUsername: oldClient.AccountName,
      username: updateData.AccountName,
      password: updateData.Password,
      profile: updateData.Profile,
      location: updateData.ServerLocation || oldClient.ServerLocation
    });

    // 🔥 FORCE APPLY PROFILE (IMPORTANT)
    await disconnectPPPoEUser(
      updateData.AccountName,
      updateData.ServerLocation || oldClient.ServerLocation
    );

    res.json({
      _id: result.insertedId,
      ...data
    });
  } catch (err) {
    console.error("❌ CREATE ERROR:", err);
    res.status(500).json({ error: err.message });
  }
};

// ✅ UPDATE CLIENT
exports.updateClient = async (req, res) => {
  try {
    const id = req.params.id;

    // 🔥 get old client data
    const oldClient = await mongoose.connection.db
      .collection("clients")
      .findOne({ _id: new mongoose.Types.ObjectId(id) });

    if (!oldClient) {
      return res.status(404).json({ error: "Client not found" });
    }

    const { _id, ...updateData } = req.body;

    // ✅ update DB first
    await mongoose.connection.db
      .collection("clients")
      .updateOne(
        { _id: new mongoose.Types.ObjectId(id) },
        { $set: updateData }
      );

    // 🔥 UPDATE PPP USER
    await updatePPPoEUser({
      oldUsername: oldClient.AccountName,
      username: updateData.AccountName,
      password: updateData.Password,
      profile: updateData.Profile,
      location: updateData.ServerLocation || oldClient.ServerLocation
    });

    res.json({ message: "Client and PPP updated successfully" });
  } catch (err) {
    console.error("❌ UPDATE ERROR:", err);
    res.status(500).json({ error: err.message });
  }
};

console.log("EXPORTS:", module.exports);

// ✅ GET NETPLANS
exports.getNetPlans = async (req, res) => {
  try {
    const data = await mongoose.connection.db
      .collection("NetPlan")
      .find({})
      .toArray();

    console.log("✅ NETPLAN COUNT:", data.length);
    res.json(data);
  } catch (err) {
    console.error("❌ QUERY ERROR:", err);
    res.status(500).json({ error: err.message });
  }
};



