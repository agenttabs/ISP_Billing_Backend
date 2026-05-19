const mongoose = require("mongoose");
const collections = require("../config/collections");
const { writeAuditLog } = require("../services/audit-log.service");
const {
  sendDirectSms,
  getSmsTemplateByType,
  replaceSmsTokens
} = require("../services/sms.service");
const { emitClientsChanged } = require("../services/realtime.service");

const { addPPPoEUser, addIpoeDisconnectScheduler, checkPPPoEUser, clearIpoeLeaseComment, updatePPPoEUser, disconnectPPPoEUser, removePPPoEActiveConnection, addDisconnectScheduler, removeScheduler, getDhcpLeaseByMacAddress, getDhcpLeasesNoComment, getDhcpLeasesWithComments, setIpoeLeaseStatic, getClientMikrotikStatus } = require("../services/mikrotik");



// ✅ TEST
exports.testAPI = (req, res) => {
  res.send("API WORKING");
};

//delay 2sec
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function run() {
  console.log("Start");

  await delay(3000);

  console.log("After 2 seconds");
}

const isDisconnectedPlanValue = (...values) =>
  values.some((value) =>
    String(value || "").toUpperCase().includes("DISCONNECTION") ||
    String(value || "").toUpperCase().includes("DISCONNECTED") ||
    String(value || "").toUpperCase() === "DC-PUTOL"
  );

const parseAmountValue = (value) => {
  if (value === null || value === undefined || value === "") {
    return 0;
  }

  const parsed = Number(String(value).replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : 0;
};

const PPP_DISCONNECTED_PROFILE = "dc-putol";

const buildDisconnectedClientFilter = () => ({
  $or: [
    { Status: { $regex: /DISCONNECTED/i } },
    { Profile: { $regex: /DISCONNECTION/i } },
    { NetPlan: { $regex: /DISCONNECTION/i } }
  ]
});

const getIpoeModemStatus = (lease) => {
  if (!lease) {
    return "NO MAC FOUND";
  }

  const leaseStatus = String(lease.status || "").trim().toUpperCase();
  const comment = String(lease.comment || "").trim();
  const planMatch = comment.match(/PLAN=([^;]+)/i);
  const planValue = String(planMatch?.[1] || "").trim().toUpperCase();

  if (leaseStatus !== "BOUND") {
    return "NOT ACTIVE";
  }

  if (!comment || planValue === "0M/0M") {
    return "HOLD";
  }

  return "ACTIVE";
};


// ✅ GET CLIENTS
exports.getClients = async (req, res) => {
  try {
    const data = await mongoose.connection.db
      .collection(collections.clients)
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
exports.getClientById = async (req, res) => {
  try {
    const client = await mongoose.connection.db
      .collection(collections.clients)
      .findOne({ _id: new mongoose.Types.ObjectId(req.params.id) });

    if (!client) {
      return res.status(404).json({ error: "Client not found" });
    }

    res.json(client);
  } catch (err) {
    console.error("GET CLIENT BY ID ERROR:", err);
    res.status(500).json({ error: err.message });
  }
};

exports.createClient = async (req, res) => {
  try {
    const location = req.body.ServerLocation || "CCR2116";
    const authMode = req.body.AuthenticationMode || "";
    const nextMacAddress = req.body.MacAddress || req.body.macAddress || "";
    const isDisconnectedPlan = isDisconnectedPlanValue(
      req.body.Profile,
      req.body.NetPlan
    );

    // ✅ CHECK DB DUPLICATE
    const existing = await mongoose.connection.db
      .collection(collections.clients)
      .findOne({ AccountName: req.body.AccountName });

    if (existing) {
      return res.status(400).json({
        error: "Account already exists in database"
      });
    }

    // ✅ CHECK MIKROTIK DUPLICATE
    if (authMode === "PPPOE") {
      const existsInRouter = await checkPPPoEUser(
        req.body.AccountName,
        location
      );

      if (existsInRouter) {
        return res.status(400).json({
          error: "Account already exists in MikroTik"
        });
      }
    }

    // ✅ PREPARE DATA
    const data = {
      ClientName: req.body.ClientName || "",
      AccountName: req.body.AccountName || "",
      Password: req.body.Password || "",
      Address: req.body.Address || "",
      Latitude: req.body.Latitude || "",
      Longitude: req.body.Longitude || "",
      ContactNumber: req.body.ContactNumber || "",
      AuthenticationMode: req.body.AuthenticationMode || "",
      MacAddress: nextMacAddress,
      Profile: req.body.Profile || "",
      NetPlan: req.body.NetPlan || "",
      AmountDue: req.body.AmountDue || 0,
      DueDate: req.body.DueDate || "",
      SubscriptionCover: req.body.SubscriptionCover || "UN-GROUPED",
      Status: "ACTIVE",
      Note: req.body.Note || "",
      AccountNumber: req.body.AccountNumber || "",
      DateEntry: req.body.DateEntry || "",
      Email: req.body.Email || "N/A",
      EmailBillingEnabled: Boolean(req.body.EmailBillingEnabled),
      Facebook: "N/A",
      createdAt: new Date(),
      PaymentStatus: "UNPAID",
      ServerLocation: location
    };

    // ✅ SAVE TO DB
    const result = await mongoose.connection.db
      .collection(collections.clients)
      .insertOne(data);

    // ✅ CREATE PPP USER (FIXED)
    if (authMode === "PPPOE") {
      await addPPPoEUser({
        username: data.AccountName,
        password: data.Password,
        profile: data.Profile,
        location: data.ServerLocation
      });
    }

    if (authMode === "IPOE") {
      await setIpoeLeaseStatic({
        macAddress: data.MacAddress,
        plan: data.NetPlan,
        accountName: data.AccountName
      });
    }

    if (authMode === "IPOE") {
      if (!isDisconnectedPlan) {
        await addIpoeDisconnectScheduler({
          username: data.AccountName,
          dueDate: data.DueDate,
          macAddress: data.MacAddress,
          location: data.ServerLocation
        });
      }
    } else {
      await addDisconnectScheduler({
        username: data.AccountName,
        dueDate: data.DueDate,
        location: data.ServerLocation
      });
    }

    emitClientsChanged({
      action: "create",
      clientId: String(result.insertedId),
      accountName: data.AccountName || ""
    });

    res.json({
      _id: result.insertedId,
      ...data
    });

    await writeAuditLog({
      req,
      module: "CLIENT",
      action: "CREATE",
      targetType: "CLIENT",
      targetId: result.insertedId,
      accountName: data.AccountName,
      status: "SUCCESS",
      summary: "Client created.",
      values: data
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
      .collection(collections.clients)
      .findOne({ _id: new mongoose.Types.ObjectId(id) });

    if (!oldClient) {
      return res.status(404).json({ error: "Client not found" });
    }

    const { _id, ...updateData } = req.body;
    delete updateData.macAddress;
    let normalizedMacAddress =
      updateData.MacAddress || updateData.macAddress || oldClient.MacAddress || oldClient.macAddress || "";
    const oldMacAddress = String(oldClient.MacAddress || oldClient.macAddress || "").trim().toUpperCase();
    const oldAuthMode = String(oldClient.AuthenticationMode || "").trim().toUpperCase();
    const oldProfileValue = oldClient.Profile || "";
    const oldNetPlanValue = oldClient.NetPlan || "";

    const nextAuthMode = String(
      updateData.AuthenticationMode || oldClient.AuthenticationMode || ""
    )
      .trim()
      .toUpperCase();
    const nextProfileValue = updateData.Profile || oldProfileValue;
    const nextNetPlanValue = updateData.NetPlan || oldNetPlanValue;
    const nextAccountName = updateData.AccountName || oldClient.AccountName;
    const nextDueDate = updateData.DueDate || oldClient.DueDate;
    const nextAmountDue = parseAmountValue(
      updateData.AmountDue ?? oldClient.AmountDue
    );
    const nextIsDisconnectedPlan = isDisconnectedPlanValue(
      nextProfileValue,
      nextNetPlanValue
    );
    const pullOutCommentMatch = String(updateData.Note || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .reverse()
      .find((line) => /pull\s*out/i.test(line));
    const pppoeDisconnectRemark =
      pullOutCommentMatch || (nextIsDisconnectedPlan ? "Disconnected by billing" : "");
    const macAddressForDisconnectCheck = String(
      normalizedMacAddress || oldClient.MacAddress || oldClient.macAddress || ""
    ).trim().toUpperCase();

    if (nextAuthMode === "IPOE" && nextIsDisconnectedPlan) {
      if (macAddressForDisconnectCheck) {
        await clearIpoeLeaseComment({
          macAddress: macAddressForDisconnectCheck
        });
      }

      normalizedMacAddress = "";
    }

    if (
      String(nextAuthMode || "").trim().toUpperCase() === "IPOE" &&
      !nextIsDisconnectedPlan &&
      !String(normalizedMacAddress || "").trim()
    ) {
      return res.status(400).json({
        error: "MAC Address is required for an active IPOE client."
      });
    }

    updateData.MacAddress = normalizedMacAddress;
    updateData.Status = nextIsDisconnectedPlan ? "DISCONNECTED" : "ACTIVE";
    const nextMacAddressUpper = String(normalizedMacAddress || "").trim().toUpperCase();
    const nextMacAddress = normalizedMacAddress;

    // ✅ update DB first
    await mongoose.connection.db
      .collection(collections.clients)
      .updateOne(
        { _id: new mongoose.Types.ObjectId(id) },
        { $set: updateData }
      );

      // 🔥 UPDATE PPP USER
      if (oldAuthMode === "PPPOE" && nextAuthMode === "IPOE") {
      console.log("=== CLIENT CONTROLLER PPP -> IPOE TRANSITION ===");
      console.log("PPP OLD ACCOUNT:", oldClient.AccountName);
      console.log("PPP DISCONNECTED PROFILE:", PPP_DISCONNECTED_PROFILE);
        await updatePPPoEUser({
          oldUsername: oldClient.AccountName,
          username: oldClient.AccountName,
          password: oldClient.Password || updateData.Password || "",
          profile: PPP_DISCONNECTED_PROFILE,
          location: updateData.ServerLocation || oldClient.ServerLocation,
          disconnectRemark: pppoeDisconnectRemark
        });
        await disconnectPPPoEUser(
          oldClient.AccountName,
          updateData.ServerLocation || oldClient.ServerLocation
        );
        console.log("=== CLIENT CONTROLLER PPP -> IPOE DONE ===");
      } else if (nextAuthMode === "PPPOE") {
      console.log("=== CLIENT CONTROLLER PPP UPDATE CALL ===");
      console.log("PPP UPDATE ACCOUNT:", updateData.AccountName || oldClient.AccountName);
      console.log("PPP UPDATE PROFILE:", updateData.Profile || oldClient.Profile);
        await updatePPPoEUser({
          oldUsername: oldClient.AccountName,
          username: updateData.AccountName,
          password: updateData.Password,
          profile: updateData.Profile,
          location: updateData.ServerLocation || oldClient.ServerLocation,
          disconnectRemark: nextIsDisconnectedPlan ? pppoeDisconnectRemark : ""
        });
        if (nextIsDisconnectedPlan) {
          await disconnectPPPoEUser(
            nextAccountName,
            updateData.ServerLocation || oldClient.ServerLocation
          );
        }
        console.log("=== CLIENT CONTROLLER PPP UPDATE DONE ===");
      }

    if (oldAuthMode === "IPOE" && oldMacAddress && oldMacAddress !== nextMacAddressUpper) {
      await clearIpoeLeaseComment({
        macAddress: oldMacAddress
      });
    }

    if (nextAuthMode === "IPOE" && !nextIsDisconnectedPlan) {
      const leaseUpdateResult = await setIpoeLeaseStatic({
        macAddress: normalizedMacAddress,
        plan: nextNetPlanValue,
        accountName: nextAccountName
      });

      if (!leaseUpdateResult) {
        return res.status(400).json({
          error: `No DHCP lease was updated for MAC ${normalizedMacAddress}.`
        });
      }
    }
    const dueChanged = oldClient.DueDate !== nextDueDate;
    const accountChanged = oldClient.AccountName !== nextAccountName;
    const macChanged = oldMacAddress !== nextMacAddressUpper;
    const authChanged =
      String(oldClient.AuthenticationMode || "").trim().toUpperCase() !==
      nextAuthMode;
    const planChanged =
      oldProfileValue !== nextProfileValue ||
      oldNetPlanValue !== nextNetPlanValue;
    const shouldAlwaysRefreshIpoeScheduler =
      nextAuthMode === "IPOE" && !nextIsDisconnectedPlan;
    const schedulerNeedsRefresh =
      dueChanged ||
      accountChanged ||
      macChanged ||
      authChanged ||
      planChanged ||
      shouldAlwaysRefreshIpoeScheduler;
    const shouldForceRemoveDisconnectedScheduler =
      nextAuthMode === "IPOE" && nextIsDisconnectedPlan;

    if (schedulerNeedsRefresh || shouldForceRemoveDisconnectedScheduler) {
      console.log("📅 Scheduler details changed → updating scheduler");

      // REMOVE OLD/CURRENT scheduler names so MikroTik cleanup follows AccountName changes
      const schedulerNamesToRemove = [
        oldClient.AccountName,
        nextAccountName
      ].filter(Boolean);

      for (const schedulerName of [...new Set(schedulerNamesToRemove)]) {
        await removeScheduler({
          username: schedulerName,
          location: updateData.ServerLocation || oldClient.ServerLocation
        });
      }

      // await upsertScheduler({
      //   username: updateData.AccountName || oldClient.AccountName,
      //   dueDate: updateData.DueDate,
      //   location: updateData.ServerLocation || oldClient.ServerLocation
      // });

      // // CREATE NEW
      if (nextAmountDue > 0) {
        if (nextAuthMode === "IPOE") {
          if (!nextIsDisconnectedPlan) {
            await addIpoeDisconnectScheduler({
              username: nextAccountName,
              dueDate: nextDueDate,
              macAddress: nextMacAddress,
              location: updateData.ServerLocation || oldClient.ServerLocation
            });
          }
        } else {
          await addDisconnectScheduler({
            username: nextAccountName,
            dueDate: nextDueDate,
            location: updateData.ServerLocation || oldClient.ServerLocation
          });
        }
      }

    }

    emitClientsChanged({
      action: "update",
      clientId: String(id),
      accountName: nextAccountName || oldClient.AccountName || ""
    });

    res.json({ message: "Client network settings updated successfully" });

    await writeAuditLog({
      req,
      module: "CLIENT",
      action: "UPDATE",
      targetType: "CLIENT",
      targetId: id,
      accountName: nextAccountName,
      status: "SUCCESS",
      summary: "Client updated.",
      details: {
        previousAccountName: oldClient.AccountName,
        previousAuthMode: oldAuthMode,
        previousProfile: oldProfileValue,
        previousNetPlan: oldNetPlanValue,
        previousDueDate: oldClient.DueDate,
        previousMacAddress: oldMacAddress
      },
      values: updateData
    });
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
      .collection(collections.netPlans)
      .find({})
      .toArray();

    console.log("✅ NETPLAN COUNT:", data.length);
    res.json(data);
  } catch (err) {
    console.error("❌ QUERY ERROR:", err);
    res.status(500).json({ error: err.message });
  }
};

exports.adjustClientDueDate = async (req, res) => {
  try {
    const id = req.params.id;
    const dueDate = req.body.DueDate;
    const subscriptionCover = req.body.SubscriptionCover;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid client id." });
    }

    if (!dueDate) {
      return res.status(400).json({ error: "DueDate is required." });
    }

    const objectId = new mongoose.Types.ObjectId(id);
    const existingClient = await mongoose.connection.db
      .collection(collections.clients)
      .findOne({ _id: objectId });

    if (!existingClient) {
      return res.status(404).json({ error: "Client not found." });
    }

    await mongoose.connection.db
      .collection(collections.clients)
      .updateOne(
        { _id: objectId },
        {
          $set: {
            DueDate: dueDate,
            SubscriptionCover:
              subscriptionCover || String(new Date(dueDate).getDate()),
            updatedAt: new Date()
          }
        }
      );

    emitClientsChanged({
      action: "adjust-due-date",
      clientId: String(id),
      accountName: existingClient.AccountName || ""
    });

    res.json({ message: "Client due date updated successfully." });

    await writeAuditLog({
      req,
      module: "CLIENT",
      action: "ADJUST_DUE_DATE",
      targetType: "CLIENT",
      targetId: id,
      accountName: existingClient.AccountName || "",
      status: "SUCCESS",
      summary: "Client due date adjusted.",
      details: {
        previousDueDate: existingClient.DueDate,
        nextDueDate: dueDate,
        subscriptionCover
      }
    });
  } catch (err) {
    console.error("❌ ADJUST DUE DATE ERROR:", err);
    res.status(500).json({ error: err.message });
  }
};

exports.refreshClientPppoeMode = async (req, res) => {
  try {
    const { id } = req.params;
    const objectId = new mongoose.Types.ObjectId(id);
    const client = await mongoose.connection.db
      .collection(collections.clients)
      .findOne({ _id: objectId });

    if (!client) {
      return res.status(404).json({ error: "Client not found." });
    }

    const authMode = String(client.AuthenticationMode || "").trim().toUpperCase();
    if (authMode !== "PPPOE") {
      return res.status(400).json({ error: "Refresh mode is only available for PPPoE clients." });
    }

    const accountName = String(client.AccountName || "").trim();
    if (!accountName) {
      return res.status(400).json({ error: "Client account name is required to refresh PPPoE mode." });
    }

    const result = await removePPPoEActiveConnection(accountName);

    res.json({
      message:
        result.removedCount > 0
          ? "PPPoE active connection removed. The client can reconnect now."
          : "No active PPPoE connection found for this client.",
      ...result
    });

    await writeAuditLog({
      req,
      module: "CLIENT",
      action: "REFRESH_PPPOE_MODE",
      targetType: "CLIENT",
      targetId: id,
      accountName,
      status: "SUCCESS",
      summary: "Client PPPoE active connection refreshed.",
      details: result
    });
  } catch (err) {
    console.error("PPPOE REFRESH MODE ERROR:", err);
    res.status(500).json({ error: err.message });
  }
};

exports.createRepairRequest = async (req, res) => {
  try {
    const id = req.params.id;
    const technicianId = String(req.body.technicianId || "").trim();
    const technicianNameInput = String(req.body.technicianName || "").trim();
    const repairText = String(
      req.body.repairText || req.body.message || req.body.notes || ""
    ).trim();
    const repairTemplate = await getSmsTemplateByType("smsRepairTech");

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid client id." });
    }

    if (!technicianId && !technicianNameInput) {
      return res.status(400).json({ error: "Technician is required." });
    }

    if (!repairText && !repairTemplate?.Body) {
      return res.status(400).json({ error: "Repair details are required." });
    }

    const client = await mongoose.connection.db
      .collection(collections.clients)
      .findOne({ _id: new mongoose.Types.ObjectId(id) });

    if (!client) {
      return res.status(404).json({ error: "Client not found." });
    }

    const credentialCollection = mongoose.connection.db.collection(
      collections.credentials
    );

    const technician = technicianId
      ? await credentialCollection.findOne({ ID: technicianId })
      : await credentialCollection.findOne({ Name: technicianNameInput });

    if (!technician) {
      return res.status(404).json({ error: "Technician not found." });
    }

    const technicianType = String(technician.Type || "").trim().toUpperCase();
    if (!["TECHNICIAN", "EMPLOYEE"].includes(technicianType)) {
      return res.status(400).json({ error: "Selected user is not a technician." });
    }

    const technicianContact = String(
      technician.Contact || technician.contact || ""
    ).trim();

    const repairRequest = {
      clientId: String(client._id),
      accountName: client.AccountName || "",
      clientName: client.ClientName || "",
      accountNumber: client.AccountNumber || "",
      contactNumber: client.ContactNumber || "",
      address: client.Address || "",
      technicianId: String(technician.ID || technicianId || "").trim(),
      technicianName: String(technician.Name || technicianNameInput || "").trim(),
      technicianUsername: String(technician.Username || "").trim(),
      technicianContact,
      repairText,
      createdAt: new Date()
    };

    const smsMessage = repairTemplate?.Body
      ? replaceSmsTokens(repairTemplate.Body, {
          TechnicianName: repairRequest.technicianName || "",
          ClientName: repairRequest.clientName || repairRequest.accountName || "",
          AccountName: repairRequest.accountName || "",
          AccountNumber: repairRequest.accountNumber || "",
          ContactNumber: repairRequest.contactNumber || "",
          Address: repairRequest.address || "",
          RepairText: repairRequest.repairText || "",
          Issue: repairRequest.repairText || ""
        })
      : [
          "DNS Repair Request",
          `Technician: ${repairRequest.technicianName || "-"}`,
          `Client: ${repairRequest.clientName || repairRequest.accountName || "-"}`,
          `Account: ${repairRequest.accountName || "-"}`,
          `Contact: ${repairRequest.contactNumber || "-"}`,
          `Address: ${repairRequest.address || "-"}`,
          `Issue: ${repairRequest.repairText}`
        ].join("\n");

    let smsResult;
    try {
      smsResult = await sendDirectSms({
        recipient: technicianContact,
        message: smsMessage
      });
    } catch (smsError) {
      smsResult = {
        sent: false,
        reason: smsError.message || "SMS gateway request failed."
      };
    }

    await writeAuditLog({
      req,
      module: "REPAIR",
      action: "SEND_REQUEST",
      targetType: "REPAIR",
      targetId: `${id}-${Date.now()}`,
      accountName: client.AccountName || "",
      status: smsResult?.sent ? "SUCCESS" : "FAILED",
      summary: smsResult?.sent
        ? "Repair request SMS sent."
        : "Repair request SMS failed.",
      details: {
        clientId: String(client._id),
        dueDate: client.DueDate || "",
        authenticationMode: client.AuthenticationMode || "",
        netPlan: client.NetPlan || client.Profile || "",
        templateType: "smsRepairTech",
        templateFound: Boolean(repairTemplate?.Body),
        smsResult
      },
      values: repairRequest
    });

    return res.status(201).json({
      message: smsResult?.sent
        ? "Repair request SMS sent successfully."
        : smsResult?.reason || "Repair request SMS failed.",
      repairRequest,
      smsResult
    });
  } catch (err) {
    console.error("REPAIR REQUEST ERROR:", err);
    return res.status(500).json({ error: err.message });
  }
};

exports.getDhcpLeases = async (req, res) => {
  try {
    const data = await getDhcpLeasesNoComment();
    res.json(data);
  } catch (err) {
    console.error("DHCP LEASE QUERY ERROR:", err);
    res.status(500).json({ error: err.message });
  }
};

exports.getDhcpLeasesAll = async (req, res) => {
  try {
    const data = await getDhcpLeasesWithComments();
    res.json(data);
  } catch (err) {
    console.error("DHCP LEASE ALL QUERY ERROR:", err);
    res.status(500).json({ error: err.message });
  }
};

exports.getClientMikrotikStatus = async (req, res) => {
  try {
    const id = req.params.id;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid client id." });
    }

    const client = await mongoose.connection.db
      .collection(collections.clients)
      .findOne({ _id: new mongoose.Types.ObjectId(id) });

    if (!client) {
      return res.status(404).json({ error: "Client not found." });
    }

    const mikrotikStatus = await getClientMikrotikStatus({
      authMode: client.AuthenticationMode,
      accountName: client.AccountName,
      macAddress: client.MacAddress || client.macAddress || ""
    });

    res.json({
      clientId: client._id,
      accountName: client.AccountName || "",
      clientName: client.ClientName || "",
      authMode: String(client.AuthenticationMode || "").trim().toUpperCase(),
      plan: mikrotikStatus.plan || client.NetPlan || client.Profile || "",
      ipAddress: mikrotikStatus.ipAddress || "",
      macAddress:
        mikrotikStatus.macAddress ||
        String(client.MacAddress || client.macAddress || "").trim().toUpperCase(),
      status: mikrotikStatus.status || "UNKNOWN",
      rxBytes: Number(mikrotikStatus.rxBytes || 0),
      txBytes: Number(mikrotikStatus.txBytes || 0),
      graphAvailable: Boolean(mikrotikStatus.graphAvailable)
    });
  } catch (err) {
    console.error("CLIENT MIKROTIK STATUS ERROR:", err);
    res.status(500).json({ error: err.message });
  }
};

exports.getClients = async (req, res) => {
  try {
    const collection = mongoose.connection.db.collection(collections.clients);
    const status = String(req.query?.status || "ACTIVE").trim().toUpperCase();
    const rawSearch = String(req.query?.search || "").trim();
    const page = Math.max(Number.parseInt(req.query?.page, 10) || 1, 1);
    const limit = Math.min(Math.max(Number.parseInt(req.query?.limit, 10) || 10, 1), 100);
    const skip = (page - 1) * limit;

    const disconnectedFilter = buildDisconnectedClientFilter();
    const statusFilter =
      status === "DISCONNECTED"
        ? disconnectedFilter
        : { $nor: disconnectedFilter.$or };

    const query = { ...statusFilter };

    if (rawSearch) {
      const escapedSearch = rawSearch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const searchRegex = new RegExp(`(?:^|[\\s_-])${escapedSearch}`, "i");

      query.$and = [
        ...(query.$and || []),
        {
          $or: [
            { AccountName: searchRegex },
            { ClientName: searchRegex }
          ]
        }
      ];
    }

    const [rows, total, activeCount, disconnectedCount] = await Promise.all([
      collection
        .find(query)
        .sort({ AccountName: 1, ClientName: 1, _id: 1 })
        .skip(skip)
        .limit(limit)
        .toArray(),
      collection.countDocuments(query),
      collection.countDocuments({ $nor: disconnectedFilter.$or }),
      collection.countDocuments(disconnectedFilter)
    ]);

    res.json({
      rows,
      meta: {
        total,
        activeCount,
        disconnectedCount,
        page,
        limit
      }
    });
  } catch (err) {
    console.error("CLIENT SEARCH QUERY ERROR:", err);
    res.status(500).json({ error: err.message });
  }
};



